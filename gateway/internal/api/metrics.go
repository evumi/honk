package api

import (
	"context"
	"github.com/go-chi/chi/v5/middleware"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/evumi/honk/gateway/internal/metrics"
)

type serverMetrics struct {
	reg         *metrics.Registry
	messages    *metrics.Counter // by kind
	pushes      *metrics.Counter // by platform, result
	pushRetries *metrics.Counter
	pushDropped *metrics.Counter // by reason
	httpReqs    *metrics.Counter // by method class, status class
}

func (s *Server) initMetrics() {
	r := metrics.New()
	s.m = serverMetrics{
		reg:         r,
		messages:    r.Counter("honk_messages_total", "Queued messages by kind.", "kind"),
		pushes:      r.Counter("honk_pushes_total", "Push attempts by platform (direct) and result.", "platform", "route", "result"),
		pushRetries: r.Counter("honk_push_retries_total", "Push retries started."),
		pushDropped: r.Counter("honk_push_dropped_total", "Pushes given up before sending, by reason.", "reason"),
		httpReqs:    r.Counter("honk_http_requests_total", "HTTP requests by status class.", "class"),
	}
	count := func(pick func(d, b int) int) func() float64 {
		return func() float64 {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			d, b, err := s.store.Counts(ctx)
			if err != nil {
				return math.NaN()
			}
			return float64(pick(d, b))
		}
	}
	r.Gauge("honk_devices", "Registered devices.", count(func(d, _ int) int { return d }))
	r.Gauge("honk_bots", "Bots.", count(func(_, b int) int { return b }))
	r.Gauge("honk_push_queue_length", "Pushes waiting in the queue.", func() float64 { return float64(len(s.pq.jobs)) })
}

// Metrics is the registry behind /metrics.
func (s *Server) Metrics() http.Handler { return s.m.reg.Handler() }

// instrument counts requests by status class and, with AccessLog, logs each at
// debug level. The bot token in /bot<token>/<method> is never logged.
func (s *Server) instrument(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		status := ww.Status()
		if status == 0 {
			status = http.StatusOK
		}
		s.m.httpReqs.Inc(strconv.Itoa(status/100) + "xx")
		if s.opts.AccessLog {
			s.log.Debug("request", "method", r.Method, "path", redactPath(r.URL.Path), "status", status,
				"bytes", ww.BytesWritten(), "ms", time.Since(start).Milliseconds(), "remote", r.RemoteAddr)
		}
	})
}

func redactPath(p string) string {
	if strings.HasPrefix(p, "/bot") {
		if i := strings.IndexByte(p[1:], '/'); i > 0 {
			return "/bot<token>" + p[1+i:]
		}
		return "/bot<token>"
	}
	return p
}
