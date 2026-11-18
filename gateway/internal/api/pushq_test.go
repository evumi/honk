package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/evumi/honk/gateway/internal/push"
	"github.com/evumi/honk/gateway/internal/store"
)

// scriptPusher returns the scripted errors in order, then nil, and records when each call happened.
type scriptPusher struct {
	mu    sync.Mutex
	errs  []error
	times []time.Time
	block chan struct{}
}

func (p *scriptPusher) Push(ctx context.Context, n push.Notification) error {
	p.mu.Lock()
	i := len(p.times)
	p.times = append(p.times, time.Now())
	var err error
	if i < len(p.errs) {
		err = p.errs[i]
	}
	block := p.block
	p.mu.Unlock()
	if block != nil {
		<-block
	}
	return err
}

func (p *scriptPusher) calls() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.times)
}

func retryable(after time.Duration) error {
	return &push.RetryableError{Err: errors.New("503"), After: after}
}

func retryEnv(t *testing.T, opts Options, p *scriptPusher) (*env, string, string, string) {
	opts.MessageTTL, opts.SendRate, opts.SendBurst = time.Hour, 1000, 100
	e := setupWith(t, opts)
	e.s.pusher = p
	secret, token := e.register("ios")
	return e, secret, token, secret
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestPushRetriesUntilItWorks(t *testing.T) {
	p := &scriptPusher{errs: []error{retryable(0), retryable(0)}}
	e, _, token, _ := retryEnv(t, Options{PushBackoff: []time.Duration{5 * time.Millisecond, 5 * time.Millisecond, 5 * time.Millisecond}}, p)
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x"}))
	waitFor(t, "3 pushes", func() bool { return p.calls() == 3 })
	time.Sleep(60 * time.Millisecond)
	if p.calls() != 3 {
		t.Errorf("calls = %d after success, want 3", p.calls())
	}
	if got := e.s.m.pushes.Value("ios", "direct", "retry"); got != 2 {
		t.Errorf("retry results = %d, want 2", got)
	}
	if got := e.s.m.pushes.Value("ios", "direct", "ok"); got != 1 {
		t.Errorf("ok results = %d, want 1", got)
	}
}

func TestPushGivesUpAfterFourAttempts(t *testing.T) {
	errs := []error{retryable(0), retryable(0), retryable(0), retryable(0), retryable(0)}
	p := &scriptPusher{errs: errs}
	e, _, token, _ := retryEnv(t, Options{PushBackoff: []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}}, p)
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x"}))
	waitFor(t, "4 pushes", func() bool { return p.calls() == 4 })
	waitFor(t, "failure counted", func() bool { return e.s.m.pushes.Value("ios", "direct", "failed") == 1 })
	time.Sleep(30 * time.Millisecond)
	if p.calls() != 4 {
		t.Errorf("calls = %d, want 4", p.calls())
	}
}

func TestPushDoesNotRetryPermanentErrors(t *testing.T) {
	p := &scriptPusher{errs: []error{errors.New("apns: 400 BadTopic")}}
	e, _, token, _ := retryEnv(t, Options{PushBackoff: []time.Duration{time.Millisecond}}, p)
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x"}))
	time.Sleep(50 * time.Millisecond)
	if p.calls() != 1 {
		t.Errorf("calls = %d, want 1", p.calls())
	}
}

func TestPushRetryAfterIsHonoured(t *testing.T) {
	p := &scriptPusher{errs: []error{retryable(150 * time.Millisecond)}}
	e, _, token, _ := retryEnv(t, Options{PushBackoff: []time.Duration{time.Millisecond}}, p)
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x"}))
	waitFor(t, "2 pushes", func() bool { return p.calls() == 2 })
	p.mu.Lock()
	gap := p.times[1].Sub(p.times[0])
	p.mu.Unlock()
	if gap < 140*time.Millisecond {
		t.Errorf("retried after %v, want at least the 150 ms the service asked for", gap)
	}
}

func TestPushRetryStopsOnceAcked(t *testing.T) {
	p := &scriptPusher{errs: []error{retryable(0)}}
	e, secret, token, _ := retryEnv(t, Options{PushBackoff: []time.Duration{150 * time.Millisecond}}, p)
	m := must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x"}))
	must[map[string]any](t, e.do("POST", "/v1/ack", secret, map[string]any{"up_to": m.ID}))
	time.Sleep(350 * time.Millisecond)
	if p.calls() != 1 {
		t.Errorf("calls = %d, want 1: the device had acked the message", p.calls())
	}
	if got := e.s.m.pushDropped.Value("not_wanted"); got != 1 {
		t.Errorf("not_wanted = %d, want 1", got)
	}
}

func TestPushRetryStopsWhenTokenChanged(t *testing.T) {
	p := &scriptPusher{errs: []error{retryable(0)}}
	e, secret, token, _ := retryEnv(t, Options{PushBackoff: []time.Duration{150 * time.Millisecond}}, p)
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x"}))
	must[map[string]any](t, e.do("PUT", "/v1/devices/me", secret, map[string]string{"push_token": "tok-new"}))
	time.Sleep(350 * time.Millisecond)
	if p.calls() != 1 {
		t.Errorf("calls = %d, want 1: the push token had changed", p.calls())
	}
}

func TestPushQueueFullDrops(t *testing.T) {
	p := &scriptPusher{block: make(chan struct{})}
	e, _, token, _ := retryEnv(t, Options{PushQueue: 1, PushWorkers: 1}, p)
	// The sends wait for the blocked pusher, so they must finish before the
	// test (and its server) ends, or a late one fails after the test returns.
	var sends sync.WaitGroup
	for i := 0; i < 4; i++ { // one running, one queued, the rest dropped
		req := map[string]string{"body": "x"}
		sends.Add(1)
		go func() { defer sends.Done(); e.do("POST", "/bot"+token+"/sendMessage", "", req) }()
	}
	waitFor(t, "a drop", func() bool { return e.s.m.pushDropped.Value("queue_full") >= 1 })
	close(p.block)
	sends.Wait()
}

func TestCloseDropsWaitingRetries(t *testing.T) {
	p := &scriptPusher{errs: []error{retryable(0), retryable(0)}}
	e, _, token, _ := retryEnv(t, Options{PushBackoff: []time.Duration{100 * time.Millisecond}}, p)
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x"}))
	waitFor(t, "first push", func() bool { return p.calls() == 1 })
	e.s.Close()
	e.s.Close() // idempotent
	time.Sleep(250 * time.Millisecond)
	if p.calls() != 1 {
		t.Errorf("calls = %d after Close, want 1", p.calls())
	}
	e.s.notify(store.Device{PushOK: true, PushToken: "t", Platform: "ios"}, push.Notification{}) // must not panic
}

func httptestServe(t *testing.T, h http.Handler) string {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.URL
}
