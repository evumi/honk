package api

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/evumi/honk/gateway/internal/push"
	"github.com/evumi/honk/gateway/internal/store"
)

// maxRetryAfter caps how long a service's retry_after can hold a push.
const maxRetryAfter = 2 * time.Minute

type pushJob struct {
	dev     store.Device
	n       push.Notification
	attempt int // pushes already tried
}

// pushQueue is a bounded queue drained by a fixed number of workers. Retry
// state lives only here, in memory: after a restart the device still gets
// the message by /v1/sync.
type pushQueue struct {
	jobs chan pushJob

	mu      sync.Mutex
	idle    *sync.Cond
	pending int // queued or running
	closed  bool
	timers  map[*time.Timer]struct{} // retries waiting for their backoff
	workers sync.WaitGroup
}

func (s *Server) startPushQueue() {
	q := &s.pq
	q.jobs = make(chan pushJob, s.opts.PushQueue)
	q.idle = sync.NewCond(&q.mu)
	q.timers = map[*time.Timer]struct{}{}
	for i := 0; i < s.opts.PushWorkers; i++ {
		q.workers.Add(1)
		go func() {
			defer q.workers.Done()
			for j := range q.jobs {
				s.runPush(j)
				q.mu.Lock()
				q.pending--
				q.idle.Broadcast()
				q.mu.Unlock()
			}
		}()
	}
}

// Wait blocks until every queued or running push has had its current
// attempt; retries still waiting for their backoff are not waited for. Tests
// use it to look at the pusher; Close is the shutdown path.
func (s *Server) Wait() {
	q := &s.pq
	q.mu.Lock()
	for q.pending > 0 {
		q.idle.Wait()
	}
	q.mu.Unlock()
}

// Close stops accepting pushes, drops retries still waiting for their
// backoff, lets the current attempts finish and stops the workers. Call it
// after the HTTP server has shut down.
func (s *Server) Close() {
	q := &s.pq
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	q.closed = true
	for t := range q.timers {
		if t.Stop() {
			s.m.pushDropped.Inc("shutdown")
		}
	}
	q.timers = map[*time.Timer]struct{}{}
	close(q.jobs)
	q.mu.Unlock()
	q.workers.Wait()
}

// enqueue adds a job without blocking; a full queue drops it.
func (s *Server) enqueue(j pushJob) bool {
	q := &s.pq
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		s.m.pushDropped.Inc("shutdown")
		return false
	}
	select {
	case q.jobs <- j:
		q.pending++
		return true
	default:
		s.m.pushDropped.Inc("queue_full")
		s.log.Warn("push queue full: dropped", "device", j.dev.ID, "kind", j.n.Kind, "attempt", j.attempt)
		return false
	}
}

// notify queues a push to one device (see notifyOwner for a group): the message is already stored, so the
// bot API answers at once and a slow APNs/FCM never holds it up. A failed
// push is retried (see runPush); the device still gets the message by /sync.
// A token APNs/FCM reports gone is recorded so later pushes skip it.
func (s *Server) notify(d store.Device, n push.Notification) {
	if !d.PushOK || d.PushToken == "" {
		return
	}
	// Debug simulator builds register without APNs; they poll /v1/sync instead.
	if strings.HasPrefix(d.PushToken, SimulatorTokenPrefix) {
		return
	}
	if s.route(d.Platform) == "off" {
		s.m.pushDropped.Inc("no_route")
		return
	}
	n.Platform, n.Token = d.Platform, d.PushToken
	s.enqueue(pushJob{dev: d, n: n})
}

// notifyOwner pushes to every device of the group that can take a push.
func (s *Server) notifyOwner(ctx context.Context, ownerID string, n push.Notification) {
	ds, err := s.store.PushDevices(ctx, ownerID)
	if err != nil {
		s.log.Error("list push devices", "err", err)
		return
	}
	for _, d := range ds {
		s.notify(d, n)
	}
}

func (s *Server) runPush(j pushJob) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	d, n := j.dev, j.n
	route := s.route(n.Platform)
	if !n.Expires.IsZero() && !time.Now().Before(n.Expires) {
		// The message's ttl ran out (waiting in the queue or between retries).
		s.m.pushDropped.Inc("expired")
		return
	}
	if j.attempt > 0 {
		want, err := s.store.PushStillWanted(ctx, d.ID, d.PushToken, n.MessageID)
		if err == nil && !want {
			s.m.pushDropped.Inc("not_wanted")
			return
		}
	}
	err := s.pusher.Push(ctx, n)
	switch {
	case err == nil:
		s.m.pushes.Inc(n.Platform, route, "ok")
	case errors.Is(err, push.ErrTokenGone):
		s.m.pushes.Inc(n.Platform, route, "token_gone")
		s.log.Info("push token gone", "device", d.ID, "platform", d.Platform)
		if err := s.store.MarkPushGone(ctx, d.ID, d.PushToken); err != nil {
			s.log.Error("mark push gone", "err", err)
		}
	default:
		after, retry := push.Retryable(err)
		if !retry || j.attempt >= len(s.opts.PushBackoff) {
			s.m.pushes.Inc(n.Platform, route, "failed")
			s.log.Warn("push failed", "device", d.ID, "platform", d.Platform, "kind", n.Kind, "attempts", j.attempt+1, "err", err)
			return
		}
		s.m.pushes.Inc(n.Platform, route, "retry")
		delay := s.opts.PushBackoff[j.attempt]
		if after > delay {
			delay = min(after, maxRetryAfter)
		}
		s.log.Info("push will retry", "device", d.ID, "platform", d.Platform, "kind", n.Kind, "attempt", j.attempt+1, "in", delay, "err", err)
		s.scheduleRetry(pushJob{dev: d, n: n, attempt: j.attempt + 1}, delay)
	}
}

func (s *Server) scheduleRetry(j pushJob, delay time.Duration) {
	q := &s.pq
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		s.m.pushDropped.Inc("shutdown")
		return
	}
	var t *time.Timer
	t = time.AfterFunc(delay, func() {
		q.mu.Lock()
		delete(q.timers, t)
		q.mu.Unlock()
		s.m.pushRetries.Inc()
		s.enqueue(j)
	})
	q.timers[t] = struct{}{}
}
