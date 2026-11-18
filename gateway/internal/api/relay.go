package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/evumi/honk/gateway/internal/push"
	"github.com/evumi/honk/gateway/internal/store"
)

// maxRelayBody is the largest POST /v1/relay/push body; see push.MaxRelayRequest.
const maxRelayBody = push.MaxRelayRequest

// relayWindow is the period over which a relay's dead-token ratio is judged.
const relayWindow = time.Hour

// relayEntry is the in-memory state of one registered gateway.
type relayEntry struct {
	lim       *rate.Limiter
	touched   time.Time // last write of last_used_at
	used      time.Time
	winStart  time.Time
	total     int
	gone      int
	degraded  bool
	baseRate  rate.Limit
	baseBurst int
}

// relayState is everything the relay endpoints keep in memory; none of it is
// persisted. A push request writes nothing to the database except, at most
// once a minute per relay, last_used_at.
type relayState struct {
	mu     sync.Mutex
	relays map[string]*relayEntry
	tokens map[string]*limiter // by hash of platform and push token
	byIP   map[string]*limiter // registrations; see allowRelayRegistration
}

func (s *Server) relayEntry(id string) *relayEntry {
	e, found := s.rs.relays[id]
	if !found {
		e = &relayEntry{
			lim:      rate.NewLimiter(rate.Limit(s.opts.RelayRate), s.opts.RelayBurst),
			winStart: time.Now(), baseRate: rate.Limit(s.opts.RelayRate), baseBurst: s.opts.RelayBurst,
		}
		s.rs.relays[id] = e
	}
	return e
}

// relayError answers in Telegram's envelope; retryAfter > 0 adds parameters.retry_after.
func relayError(w http.ResponseWriter, code int, desc string, retryAfter int) {
	body := map[string]any{"ok": false, "error_code": code, "description": desc}
	if retryAfter > 0 {
		body["parameters"] = map[string]any{"retry_after": retryAfter}
		w.Header().Set("Retry-After", itoa(retryAfter))
	}
	writeJSON(w, code, body)
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// registerRelay serves POST /v1/relay/gateways: a self-hosted gateway asks for
// the credentials it will push with. No account is needed, only the client IP
// is rate limited.
func (s *Server) registerRelay(w http.ResponseWriter, r *http.Request) {
	if !s.allowRelayRegistration(r) {
		s.m.relayReqs.Inc("rate_limited")
		relayError(w, http.StatusTooManyRequests, "Too Many Requests", 60)
		return
	}
	rel, key, err := s.store.CreateRelay(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.m.relayReqs.Inc("registered")
	s.log.Info("relay registered", "relay", rel.ID)
	ok(w, map[string]any{"relay_id": rel.ID, "relay_key": key})
}

type relayPushRequest struct {
	Platform    string `json:"platform"`
	Token       string `json:"token"`
	Kind        string `json:"kind"`
	MsgID       int64  `json:"msg_id"`
	TargetID    int64  `json:"target_id"`
	BotID       string `json:"bot_id"`
	Level       string `json:"level"`
	CollapseKey string `json:"collapse_key"`
	BotName     string `json:"bot_name"`
	Title       string `json:"title"`
	Body        string `json:"body"`
	Group       string `json:"group"`
	Silent      bool   `json:"silent"`
	TTL         int    `json:"ttl"` // seconds; 0 is the default
}

// maxRelayTTL is FCM's longest ttl, four weeks, in seconds.
const maxRelayTTL = 28 * 24 * 3600

func (q relayPushRequest) check() string {
	switch {
	case q.Platform != "ios" && q.Platform != "android":
		return "platform must be ios or android"
	case q.Token == "" || len(q.Token) > 1024:
		return "token is missing or too long"
	case q.Kind != store.KindMessage && q.Kind != store.KindEdit && q.Kind != store.KindDelete:
		return "kind must be message, edit or delete"
	case q.MsgID <= 0:
		return "msg_id must be a positive integer"
	case q.TargetID < 0:
		return "target_id must not be negative"
	case !store.ValidBotID(q.BotID):
		return "bot_id is not a bot id"
	case len(q.CollapseKey) > 64:
		return "collapse_key is longer than 64 bytes"
	case q.TTL < 0 || q.TTL > maxRelayTTL:
		return "ttl must be between 0 and 2419200 seconds"
	case q.Silent && q.Kind != store.KindMessage:
		return "silent only applies to a message"
	case len(q.BotName) > 256 || len(q.Title) > 1024 || len(q.Body) > 8192 || len(q.Group) > 256:
		return "banner text is too long"
	}
	switch q.Level {
	case "", "passive", "active", "timeSensitive":
	default:
		return "level must be passive, active or timeSensitive"
	}
	return ""
}

// relayPush serves POST /v1/relay/push. It sends through this gateway's own
// APNs/FCM credentials only (Options.RelayAPNs and RelayFCM, never the Router
// that may itself lead to a relay), keeps nothing and answers with what
// happened: 200 sent, 410 token gone, 429 slow down, 502 try again later,
// 503 no credentials for the platform.
func (s *Server) relayPush(w http.ResponseWriter, r *http.Request) {
	key := bearer(r)
	if key == "" {
		s.m.relayReqs.Inc("unauthorized")
		relayError(w, http.StatusUnauthorized, "Unauthorized: unknown relay key", 0)
		return
	}
	rel, err := s.store.RelayByKey(r.Context(), key)
	if errors.Is(err, store.ErrNotFound) {
		s.m.relayReqs.Inc("unauthorized")
		relayError(w, http.StatusUnauthorized, "Unauthorized: unknown relay key", 0)
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	if rel.Blocked {
		s.m.relayReqs.Inc("blocked")
		relayError(w, http.StatusUnauthorized, "Unauthorized: relay blocked", 0)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRelayBody)
	var q relayPushRequest
	if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
		s.m.relayReqs.Inc("bad_request")
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			relayError(w, http.StatusRequestEntityTooLarge, "Request Entity Too Large", 0)
			return
		}
		relayError(w, http.StatusBadRequest, "Bad Request: invalid JSON", 0)
		return
	}
	if msg := q.check(); msg != "" {
		s.m.relayReqs.Inc("bad_request")
		relayError(w, http.StatusBadRequest, "Bad Request: "+msg, 0)
		return
	}
	var p push.Pusher
	if q.Platform == "ios" {
		p = s.opts.RelayAPNs
	} else {
		p = s.opts.RelayFCM
	}
	if p == nil {
		s.m.relayReqs.Inc("no_credentials")
		relayError(w, http.StatusServiceUnavailable, "Service Unavailable: this relay has no push credentials for "+q.Platform, 0)
		return
	}
	if wait := s.relayTokenWait(q.Platform, q.Token); wait > 0 {
		s.m.relayReqs.Inc("rate_limited")
		relayError(w, http.StatusTooManyRequests, "Too Many Requests", wait)
		return
	}
	// The relay's own budget is spent last: a request that is malformed or
	// over the token's limit must not cost the relay's other pushes.
	if wait := s.relayWait(rel.ID); wait > 0 {
		s.m.relayReqs.Inc("rate_limited")
		relayError(w, http.StatusTooManyRequests, "Too Many Requests", wait)
		return
	}
	s.touchRelay(rel.ID)

	n := push.Notification{
		Platform: q.Platform, Token: q.Token, Kind: q.Kind, MessageID: q.MsgID, TargetID: q.TargetID,
		BotID: q.BotID, Level: q.Level, CollapseKey: q.CollapseKey,
		BotName: q.BotName, Title: q.Title, Body: q.Body, Group: q.Group,
		// A push that arrived without banner text is sent without it.
		Bare:  q.BotName == "" && q.Title == "" && q.Body == "",
		Quiet: q.Silent,
	}
	if q.TTL > 0 {
		n.Expires = time.Now().Add(time.Duration(q.TTL) * time.Second)
	}
	ctx, cancel := context.WithTimeout(r.Context(), push.RelayServerTimeout)
	defer cancel()
	err = p.Push(ctx, n)
	switch {
	case err == nil:
		s.recordRelay(rel.ID, false)
		s.m.relayReqs.Inc("ok")
		s.m.relayPushes.Inc(q.Platform)
		ok(w, true)
	case errors.Is(err, push.ErrTokenGone):
		s.recordRelay(rel.ID, true)
		s.m.relayReqs.Inc("token_gone")
		relayError(w, http.StatusGone, "Gone: push token is no longer valid", 0)
	default:
		s.recordRelay(rel.ID, false)
		after, retry := push.Retryable(err)
		// Never log the token; the error text of APNs/FCM does not contain it.
		s.log.Warn("relay push failed", "relay", rel.ID, "platform", q.Platform, "kind", q.Kind, "err", err)
		switch {
		case retry && after > 0:
			s.m.relayReqs.Inc("rate_limited")
			relayError(w, http.StatusTooManyRequests, "Too Many Requests", int(math.Ceil(after.Seconds())))
		case retry:
			s.m.relayReqs.Inc("failed")
			relayError(w, http.StatusBadGateway, "Bad Gateway: push service unavailable", 0)
		default:
			s.m.relayReqs.Inc("failed")
			relayError(w, http.StatusUnprocessableEntity, "Unprocessable: push service refused the push", 0)
		}
	}
}

// relayWait takes a push from the relay's bucket and returns the seconds to
// wait when it is empty (0 = go ahead).
func (s *Server) relayWait(id string) int {
	s.rs.mu.Lock()
	defer s.rs.mu.Unlock()
	e := s.relayEntry(id)
	e.used = time.Now()
	return reserve(e.lim)
}

func reserve(l *rate.Limiter) int {
	res := l.Reserve()
	if !res.OK() {
		return 1
	}
	if d := res.Delay(); d > 0 {
		res.Cancel()
		return max(1, int(math.Ceil(d.Seconds())))
	}
	return 0
}

// relayTokenWait is the per push token limit.
func (s *Server) relayTokenWait(platform, token string) int {
	sum := sha256.Sum256([]byte(platform + "\x00" + token))
	k := hex.EncodeToString(sum[:12])
	s.rs.mu.Lock()
	defer s.rs.mu.Unlock()
	l, found := s.rs.tokens[k]
	if !found {
		per := float64(s.opts.RelayTokenPerMinute)
		l = &limiter{Limiter: rate.NewLimiter(rate.Limit(per/60), s.opts.RelayTokenPerMinute)}
		s.rs.tokens[k] = l
	}
	l.last = time.Now()
	return reserve(l.Limiter)
}

// touchRelay writes last_used_at at most once a minute per relay.
func (s *Server) touchRelay(id string) {
	s.rs.mu.Lock()
	e := s.relayEntry(id)
	due := time.Since(e.touched) > time.Minute
	if due {
		e.touched = time.Now()
	}
	s.rs.mu.Unlock()
	if due {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := s.store.TouchRelay(ctx, id); err != nil {
			s.log.Error("touch relay", "err", err)
		}
	}
}

// recordRelay counts a relayed push and slows the relay down when more than
// half of an hour's pushes (and over RelayGoneLimit of them) went to dead
// tokens: a gateway that pushes to tokens it never cleans up, or guesses
// them. The log line is for a human to block it (relays.blocked = 1).
func (s *Server) recordRelay(id string, gone bool) {
	s.rs.mu.Lock()
	defer s.rs.mu.Unlock()
	e := s.relayEntry(id)
	if time.Since(e.winStart) > relayWindow {
		if e.degraded && !(e.gone > s.opts.RelayGoneLimit && e.gone*2 > e.total) {
			e.degraded = false
			e.lim.SetLimit(e.baseRate)
			e.lim.SetBurst(e.baseBurst)
		}
		e.winStart, e.total, e.gone = time.Now(), 0, 0
	}
	e.total++
	if gone {
		e.gone++
	}
	if !e.degraded && e.gone > s.opts.RelayGoneLimit && e.gone*2 > e.total {
		e.degraded = true
		e.lim.SetLimit(e.baseRate / 10)
		e.lim.SetBurst(max(1, e.baseBurst/10))
		s.log.Warn("relay slowed down: most of its pushes go to dead tokens; block it with UPDATE relays SET blocked = 1 WHERE id = ?",
			"relay", id, "gone", e.gone, "total", e.total)
	}
}

// allowRelayRegistration takes a registration from the client IP's bucket; it
// is separate from device registration, with the same rules.
func (s *Server) allowRelayRegistration(r *http.Request) bool {
	ip := s.clientIP(r)
	s.rs.mu.Lock()
	defer s.rs.mu.Unlock()
	return bucket(s.rs.byIP, ip, rate.Limit(s.opts.RegisterPerHour/3600), s.opts.RegisterBurst).Allow()
}

// pruneRelay drops idle relay state; part of PruneLimiters.
func (s *Server) pruneRelay(cutoff time.Time) int {
	s.rs.mu.Lock()
	defer s.rs.mu.Unlock()
	n := 0
	for k, l := range s.rs.tokens {
		if l.last.Before(cutoff) {
			delete(s.rs.tokens, k)
			n++
		}
	}
	for k, l := range s.rs.byIP {
		if l.last.Before(cutoff) {
			delete(s.rs.byIP, k)
			n++
		}
	}
	for k, e := range s.rs.relays {
		if e.used.Before(cutoff) && !e.degraded {
			delete(s.rs.relays, k)
			n++
		}
	}
	return n
}
