// Package api serves the bot API (/bot<token>/<method>) and the app API (/v1).
//
// Every response uses Telegram's envelope: {"ok":true,"result":...} or
// {"ok":false,"error_code":400,"description":"..."}.
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"golang.org/x/time/rate"

	"github.com/evumi/honk/gateway/internal/push"
	"github.com/evumi/honk/gateway/internal/store"
)

// Options configures a Server.
type Options struct {
	Version    string // reported by /v1/info
	MessageTTL time.Duration
	SendRate   float64
	SendBurst  int
	// RegisterPerHour and RegisterBurst limit device registrations per client
	// IP; registration needs no credentials, so this is what stops a script
	// from filling the database. Defaults 10 and 5.
	RegisterPerHour float64
	RegisterBurst   int
	// MaxBotsPerDevice caps the bots one device can own. Default 100.
	MaxBotsPerDevice int
	// PushQueue and PushWorkers size the push queue (defaults 1024 and 16).
	PushQueue   int
	PushWorkers int
	// PushBackoff is the wait before each retry of a failed push; its length
	// is the number of retries. Default 2 s, 10 s, 60 s.
	PushBackoff []time.Duration
	// RegisterKey, when set, must be sent as register_key to register a device.
	RegisterKey string
	// AccessLog logs every request at debug level.
	AccessLog bool
}

// limiter is a token bucket with the time it was last used, so idle ones can be dropped.
type limiter struct {
	*rate.Limiter
	last time.Time
}

// Server holds the handlers' dependencies.
type Server struct {
	store  *store.Store
	pusher push.Pusher
	log    *slog.Logger
	opts   Options

	mu         sync.Mutex
	limiters   map[string]*limiter // per bot: sends
	registrars map[string]*limiter // per client IP: device registrations

	pq pushQueue
	m  serverMetrics
}

// New returns a Server.
func New(st *store.Store, p push.Pusher, log *slog.Logger, opts Options) *Server {
	if opts.RegisterPerHour <= 0 {
		opts.RegisterPerHour = 10
	}
	if opts.RegisterBurst <= 0 {
		opts.RegisterBurst = 5
	}
	if opts.MaxBotsPerDevice <= 0 {
		opts.MaxBotsPerDevice = 100
	}
	if opts.PushQueue <= 0 {
		opts.PushQueue = 1024
	}
	if opts.PushWorkers <= 0 {
		opts.PushWorkers = 16
	}
	if opts.PushBackoff == nil {
		opts.PushBackoff = []time.Duration{2 * time.Second, 10 * time.Second, time.Minute}
	}
	s := &Server{store: st, pusher: p, log: log, opts: opts, limiters: map[string]*limiter{}, registrars: map[string]*limiter{}}
	s.initMetrics()
	s.startPushQueue()
	return s
}

// Handler returns the HTTP routes.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RealIP, middleware.Recoverer, s.instrument)
	r.Use(func(next http.Handler) http.Handler { // bodies here are small
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
			next.ServeHTTP(w, r)
		})
	})

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) { ok(w, "ok") })

	r.Route("/v1", func(r chi.Router) {
		// Lets the app check that an address is a Honk gateway before switching to it.
		// api 2: bot ids are short strings (1: integers).
		r.Get("/info", func(w http.ResponseWriter, r *http.Request) {
			info := map[string]any{"name": "honk", "version": s.opts.Version, "api": APIVersion}
			if s.opts.RegisterKey != "" {
				info["register_key_required"] = true
			}
			ok(w, info)
		})
		r.Post("/devices", s.registerDevice)
		r.Group(func(r chi.Router) {
			r.Use(s.deviceAuth)
			r.Get("/devices/me", s.getDevice)
			r.Put("/devices/me", s.updateDevice)
			r.Delete("/devices/me", s.deleteDevice)
			r.Get("/bots", s.listBots)
			r.Post("/bots", s.createBot)
			r.Get("/bots/{id}", s.getBot)
			r.Patch("/bots/{id}", s.updateBot)
			r.Delete("/bots/{id}", s.deleteBot)
			r.Post("/bots/{id}/token", s.resetBotToken)
			r.Get("/messages/{id}", s.getMessage)
			r.Get("/sync", s.sync)
			r.Post("/ack", s.ack)
		})
	})

	// /bot<token>/<method>, the same shape as Telegram's Bot API.
	r.HandleFunc("/{bot}/{method}", s.botAPI)
	return r
}

// APIVersion is what /v1/info reports. 2: bot ids are short strings; app
// builds for 1 (integer ids) cannot read the bot list any more.
const APIVersion = 2

// SimulatorTokenPrefix marks the push token of a Debug iOS simulator build
// that has no APNs token: the device is registered but gets no pushes.
const SimulatorTokenPrefix = "simulator-"

// ---- responses ----

type apiError struct {
	code int
	desc string
}

func (e apiError) Error() string { return e.desc }

func badRequest(desc string) error { return apiError{http.StatusBadRequest, "Bad Request: " + desc} }

var (
	errUnauthorized = apiError{http.StatusUnauthorized, "Unauthorized"}
	errNotFound     = apiError{http.StatusNotFound, "Not Found"}
)

func ok(w http.ResponseWriter, result any) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result})
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var ae apiError
	switch {
	case errors.As(err, &ae):
	case errors.Is(err, store.ErrNotFound):
		ae = errNotFound
	default:
		s.log.Error("request failed", "path", r.URL.Path, "err", err)
		ae = apiError{http.StatusInternalServerError, "Internal Server Error"}
	}
	writeJSON(w, ae.code, map[string]any{"ok": false, "error_code": ae.code, "description": ae.desc})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false) // card HTML stays readable
	_ = enc.Encode(v)
}

// allow takes a send from the bot's bucket.
func (s *Server) allow(botID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, found := s.limiters[botID]
	if !found {
		l = &limiter{Limiter: rate.NewLimiter(rate.Limit(s.opts.SendRate), s.opts.SendBurst)}
		s.limiters[botID] = l
	}
	l.last = time.Now()
	return l.Allow()
}

// allowRegistration takes a registration from the client IP's bucket.
func (s *Server) allowRegistration(r *http.Request) bool {
	ip := r.RemoteAddr // middleware.RealIP has put the proxy's client address here
	if host, _, err := net.SplitHostPort(ip); err == nil {
		ip = host
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	l, found := s.registrars[ip]
	if !found {
		l = &limiter{Limiter: rate.NewLimiter(rate.Limit(s.opts.RegisterPerHour/3600), s.opts.RegisterBurst)}
		s.registrars[ip] = l
	}
	l.last = time.Now()
	return l.Allow()
}

// forgetBot drops a deleted bot's limiter.
func (s *Server) forgetBot(botID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.limiters, botID)
}

// PruneLimiters drops limiters unused for longer than idle; a bucket that
// idle is full again, so dropping it changes nothing. Returns how many went.
func (s *Server) PruneLimiters(idle time.Duration) int {
	cutoff := time.Now().Add(-idle)
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for id, l := range s.limiters {
		if l.last.Before(cutoff) {
			delete(s.limiters, id)
			n++
		}
	}
	for ip, l := range s.registrars {
		if l.last.Before(cutoff) {
			delete(s.registrars, ip)
			n++
		}
	}
	return n
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}
