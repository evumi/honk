package api

import (
	"net/http"

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
	r.Gauge("honk_push_queue_length", "Pushes waiting in the queue.", func() float64 { return float64(len(s.pq.jobs)) })
}

// Metrics is the registry behind /metrics.
func (s *Server) Metrics() http.Handler { return s.m.reg.Handler() }
