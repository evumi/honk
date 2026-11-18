package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/time/rate"

	"github.com/evumi/honk/gateway/internal/store"
)

// Widget queries: a card's request(data) call, forwarded to the bot as a
// widget_query update (webhook or getUpdates) and answered with
// answerWidgetQuery. Field names follow Telegram's WidgetQuery and
// answerWidgetQuery; everything here lives in memory and is gone after
// Options.QueryTimeout.
const (
	maxQueryData     = 64   // bytes, Telegram's limit for a query
	maxAnswerData    = 1024 // bytes
	maxLongPoll      = 50   // seconds
	maxPendingQuery  = 50   // per bot
	maxWebhookURL    = 2048
	maxWebhookToken  = 256
	webhookTimeout   = 5 * time.Second
	defaultQueryTTL  = 15 * time.Second
	maxQueuedUpdates = 100 // per bot waiting for getUpdates; the oldest go first
	queryBurst       = 5   // per device and bot; refilled at one a second
)

type queryResult struct {
	data string
	err  error
}

type pendingQuery struct {
	bot string // the bot's public id
	res chan queryResult
}

type queuedUpdate struct {
	id      int64
	body    json.RawMessage
	expires time.Time
}

type botQueue struct {
	updates []queuedUpdate
	wake    chan struct{} // closed (and replaced) when an update arrives
}

// queryHub holds the queries in flight and the updates waiting for getUpdates.
type queryHub struct {
	mu      sync.Mutex
	pending map[string]*pendingQuery
	queues  map[string]*botQueue
	seq     int64
}

func newQueryHub() *queryHub {
	// Update ids only ever grow, also across restarts.
	return &queryHub{pending: map[string]*pendingQuery{}, queues: map[string]*botQueue{}, seq: time.Now().UnixMilli()}
}

func (h *queryHub) queue(bot string) *botQueue {
	q := h.queues[bot]
	if q == nil {
		q = &botQueue{wake: make(chan struct{})}
		h.queues[bot] = q
	}
	return q
}

// open registers a query; the caller waits on the returned channel.
func (h *queryHub) open(bot string) (id string, update int64, res chan queryResult, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, p := range h.pending {
		if p.bot == bot {
			n++
		}
	}
	if n >= maxPendingQuery {
		return "", 0, nil, apiError{http.StatusTooManyRequests, "Too Many Requests: too many queries waiting for the bot"}
	}
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	id = hex.EncodeToString(b)
	res = make(chan queryResult, 1)
	h.pending[id] = &pendingQuery{bot: bot, res: res}
	h.seq++
	return id, h.seq, res, nil
}

func (h *queryHub) close(id string) {
	h.mu.Lock()
	delete(h.pending, id)
	h.mu.Unlock()
}

// push queues an update for getUpdates.
func (h *queryHub) push(bot string, id int64, body json.RawMessage, ttl time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	q := h.queue(bot)
	now := time.Now()
	keep := q.updates[:0]
	for _, u := range q.updates { // a bot nobody polls would otherwise collect them forever
		if now.Before(u.expires) {
			keep = append(keep, u)
		}
	}
	q.updates = keep
	if len(q.updates) >= maxQueuedUpdates { // drop the oldest
		q.updates = append(q.updates[:0], q.updates[len(q.updates)-maxQueuedUpdates+1:]...)
	}
	q.updates = append(q.updates, queuedUpdate{id: id, body: body, expires: now.Add(ttl)})
	close(q.wake)
	q.wake = make(chan struct{})
}

// take returns the bot's updates from offset on, dropping the ones before it
// (confirmed) and the expired. It also returns a channel that closes when a
// new update arrives.
func (h *queryHub) take(bot string, offset int64, limit int) ([]json.RawMessage, <-chan struct{}) {
	h.mu.Lock()
	defer h.mu.Unlock()
	q := h.queue(bot)
	now := time.Now()
	keep := q.updates[:0]
	for _, u := range q.updates {
		if u.id >= offset && now.Before(u.expires) {
			keep = append(keep, u)
		}
	}
	q.updates = keep
	out := []json.RawMessage{}
	for _, u := range keep {
		if len(out) == limit {
			break
		}
		out = append(out, u.body)
	}
	return out, q.wake
}

// pendingUpdates counts the updates waiting for the bot.
func (h *queryHub) pendingUpdates(bot string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	now := time.Now()
	if q := h.queues[bot]; q != nil {
		for _, u := range q.updates {
			if now.Before(u.expires) {
				n++
			}
		}
	}
	return n
}

// clear drops the bot's waiting updates.
func (h *queryHub) clear(bot string) {
	h.mu.Lock()
	delete(h.queues, bot)
	h.mu.Unlock()
}

// answer completes a query. A query that is gone (answered, timed out, never
// existed) and one that belongs to another bot look the same.
func (h *queryHub) answer(bot, id, data string) error {
	h.mu.Lock()
	p := h.pending[id]
	if p == nil || p.bot != bot {
		h.mu.Unlock()
		return badRequest("query is too old and response timeout expired or query ID is invalid")
	}
	delete(h.pending, id)
	h.mu.Unlock()
	p.res <- queryResult{data: data}
	return nil
}

// fail ends a query with an error (a webhook that did not take it).
func (h *queryHub) fail(id string, err error) {
	h.mu.Lock()
	p := h.pending[id]
	delete(h.pending, id)
	h.mu.Unlock()
	if p != nil {
		p.res <- queryResult{err: err}
	}
}

func (s *Server) queryTTL() time.Duration {
	if s.opts.QueryTimeout > 0 {
		return s.opts.QueryTimeout
	}
	return defaultQueryTTL
}

// extend moves the connection deadlines out for a request that is held open;
// the server's own would cut a long poll short.
func extend(w http.ResponseWriter, d time.Duration) {
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(d))
	_ = rc.SetWriteDeadline(time.Now().Add(d))
}

// ---- app side: POST /v1/queries ----

func (s *Server) postQuery(w http.ResponseWriter, r *http.Request) {
	var in struct {
		MessageID int64  `json:"message_id"`
		Data      string `json:"data"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if in.MessageID <= 0 {
		s.fail(w, r, badRequest("message_id must be a positive integer"))
		return
	}
	if n := len(in.Data); n < 1 || n > maxQueryData || !utf8.ValidString(in.Data) {
		s.fail(w, r, badRequest(fmt.Sprintf("data must be 1 to %d bytes of UTF-8", maxQueryData)))
		return
	}
	dev := device(r)
	m, err := s.store.GetMessage(r.Context(), dev.OwnerID, in.MessageID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if m.Kind != store.KindMessage || !m.AllowQueries {
		s.fail(w, r, apiError{http.StatusForbidden, "Forbidden: this message does not allow widget queries"})
		return
	}
	bot, err := s.store.GetBot(r.Context(), dev.OwnerID, m.BotID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.allowQuery(dev.ID + "/" + bot.ID) {
		s.fail(w, r, apiError{http.StatusTooManyRequests, "Too Many Requests"})
		return
	}
	ttl := s.queryTTL()
	qid, uid, res, err := s.hub.open(bot.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer s.hub.close(qid)
	update, _ := json.Marshal(map[string]any{
		"update_id":    uid,
		"widget_query": map[string]any{"id": qid, "message_id": m.ID, "data": in.Data},
	})
	if bot.WebhookURL != "" {
		s.queries.Add(1)
		go func() {
			defer s.queries.Done()
			if err := s.deliverWebhook(bot, update, ttl); err != nil {
				s.log.Warn("webhook delivery failed", "bot", bot.ID, "err", err)
				s.hub.fail(qid, apiError{http.StatusBadGateway, "Bad Gateway: the bot's webhook did not accept the query"})
			}
		}()
	} else {
		s.hub.push(bot.ID, uid, update, ttl)
	}
	extend(w, ttl+10*time.Second)
	timer := time.NewTimer(ttl)
	defer timer.Stop()
	select {
	case out := <-res:
		if out.err != nil {
			s.fail(w, r, out.err)
			return
		}
		ok(w, map[string]string{"data": out.data})
	case <-timer.C:
		s.fail(w, r, apiError{http.StatusGatewayTimeout, "Gateway Timeout: the bot did not answer in time"})
	case <-r.Context().Done():
	}
}

// allowQuery takes a query from the device-and-bot bucket (1 a second, burst 5).
func (s *Server) allowQuery(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := "q:" + key
	l, found := s.limiters[k]
	if !found {
		l = &limiter{Limiter: rate.NewLimiter(1, queryBurst)}
		s.limiters[k] = l
	}
	l.last = time.Now()
	return l.Allow()
}

// ---- bot side ----

func (s *Server) setWebhook(w http.ResponseWriter, r *http.Request, bot store.Bot, p url.Values) {
	raw, secret := p.Get("url"), p.Get("secret_token")
	if raw == "" { // Telegram: an empty url removes the webhook
		s.removeWebhook(w, r, bot)
		return
	}
	if err := s.checkWebhookURL(r.Context(), raw); err != nil {
		s.fail(w, r, err)
		return
	}
	if len(secret) > maxWebhookToken || strings.Trim(secret, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") != "" {
		s.fail(w, r, badRequest("secret_token must be up to 256 characters of A-Z, a-z, 0-9, _ and -"))
		return
	}
	if err := s.store.SetWebhook(r.Context(), bot.Key, raw, secret); err != nil {
		s.fail(w, r, err)
		return
	}
	s.hub.clear(bot.ID)
	ok(w, true)
}

func (s *Server) removeWebhook(w http.ResponseWriter, r *http.Request, bot store.Bot) {
	if err := s.store.SetWebhook(r.Context(), bot.Key, "", ""); err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, true)
}

func (s *Server) getWebhookInfo(w http.ResponseWriter, bot store.Bot) {
	ok(w, map[string]any{
		"url":                    bot.WebhookURL,
		"has_custom_certificate": false,
		"pending_update_count":   s.hub.pendingUpdates(bot.ID),
	})
}

func (s *Server) getUpdates(w http.ResponseWriter, r *http.Request, bot store.Bot, p url.Values) {
	if bot.WebhookURL != "" {
		s.fail(w, r, apiError{http.StatusConflict, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"})
		return
	}
	offset, limit, timeout := int64(0), 100, 0
	if v := p.Get("offset"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			s.fail(w, r, badRequest("offset must be an integer"))
			return
		}
		offset = n
	}
	if v := p.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			s.fail(w, r, badRequest("limit must be 1 to 100"))
			return
		}
		limit = n
	}
	if v := p.Get("timeout"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > maxLongPoll {
			s.fail(w, r, badRequest(fmt.Sprintf("timeout must be 0 to %d", maxLongPoll)))
			return
		}
		timeout = n
	}
	extend(w, time.Duration(timeout)*time.Second+10*time.Second)
	deadline := time.NewTimer(time.Duration(timeout) * time.Second)
	defer deadline.Stop()
	for {
		out, wake := s.hub.take(bot.ID, offset, limit)
		if len(out) > 0 || timeout == 0 {
			ok(w, out)
			return
		}
		select {
		case <-wake:
		case <-deadline.C:
			ok(w, []json.RawMessage{})
			return
		case <-r.Context().Done():
			return
		}
	}
}

func (s *Server) answerWidgetQuery(w http.ResponseWriter, r *http.Request, bot store.Bot, p url.Values) {
	id, data := p.Get("widget_query_id"), p.Get("data")
	if id == "" {
		s.fail(w, r, badRequest("widget_query_id is required"))
		return
	}
	if len(data) > maxAnswerData {
		s.fail(w, r, badRequest(fmt.Sprintf("data is longer than %d bytes", maxAnswerData)))
		return
	}
	if err := s.hub.answer(bot.ID, id, data); err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, true)
}

// ---- webhook delivery and the SSRF guard ----

// checkWebhookURL accepts an https URL whose host does not resolve to a
// loopback, private or link-local address (unless allowed by config).
func (s *Server) checkWebhookURL(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > maxWebhookURL || u.Host == "" || u.Hostname() == "" || u.User != nil {
		return badRequest("bad webhook: invalid URL")
	}
	if u.Scheme != "https" {
		return badRequest("bad webhook: HTTPS URL must be provided for webhook")
	}
	if s.opts.WebhookAllowPrivate {
		return nil
	}
	host := u.Hostname()
	if ip, err := netip.ParseAddr(host); err == nil {
		if !publicIP(ip) {
			return badRequest("bad webhook: IP address is not allowed")
		}
		return nil
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return badRequest("bad webhook: failed to resolve host")
	}
	for _, ip := range ips {
		if !publicIP(ip) {
			return badRequest("bad webhook: host resolves to an address that is not allowed")
		}
	}
	return nil
}

var blockedNets = func() []netip.Prefix {
	var out []netip.Prefix
	for _, c := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15", "240.0.0.0/4", "64:ff9b::/96", "100::/64"} {
		out = append(out, netip.MustParsePrefix(c))
	}
	return out
}()

// publicIP reports whether ip is an address a webhook may live on.
func publicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, n := range blockedNets {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}

// newWebhookClient returns the HTTP client for webhook deliveries: it checks
// the address it is about to connect to (so a DNS answer that changes between
// the check and the delivery gains nothing), follows no redirects and gives up
// after 5 seconds.
func newWebhookClient(allowPrivate bool, tlsCfg *tls.Config) *http.Client {
	d := &net.Dialer{Timeout: webhookTimeout}
	if !allowPrivate {
		d.Control = func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !publicIP(ap.Addr()) {
				return errors.New("webhook address is not allowed")
			}
			return nil
		}
	}
	return &http.Client{
		Timeout: webhookTimeout,
		Transport: &http.Transport{
			Proxy:               nil, // a proxy would connect on our behalf and bypass the check
			DialContext:         d.DialContext,
			TLSClientConfig:     tlsCfg,
			TLSHandshakeTimeout: webhookTimeout,
			DisableKeepAlives:   true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// deliverWebhook POSTs the update; anything but a 2xx is a failure.
func (s *Server) deliverWebhook(bot store.Bot, update []byte, ttl time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), ttl)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, bot.WebhookURL, bytes.NewReader(update))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if bot.WebhookSecret != "" {
		req.Header.Set("X-Honk-Bot-Api-Secret-Token", bot.WebhookSecret)
	}
	res, err := s.whClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("webhook answered %d", res.StatusCode)
	}
	return nil
}
