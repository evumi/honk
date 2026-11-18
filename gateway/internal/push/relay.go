package push

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Meta keys under which a Relay keeps what its relay gave it.
const (
	metaRelayURL = "relay_url"
	metaRelayID  = "relay_id"
	metaRelayKey = "relay_key"
)

// MetaStore is the small key/value store a Relay keeps its credentials in.
// GetMeta returns "" for a key that is not set; SetMeta with "" removes it.
type MetaStore interface {
	GetMeta(ctx context.Context, key string) (string, error)
	SetMeta(ctx context.Context, key, value string) error
}

// MaxRelayRequest is the largest body the relay accepts for POST
// /v1/relay/push. The worst request this client builds (every text field at
// its limit, every byte a control character that JSON writes as six) is about
// 19 KB; the cap leaves room.
const MaxRelayRequest = 32 << 10

// RelayServerTimeout is how long a relay waits for APNs/FCM; RelayClientTimeout
// is how long this client waits for the relay. The client must outlast the
// server, or it gives up on a push the relay then delivers and a retry sends
// it twice.
const (
	RelayServerTimeout = 8 * time.Second
	RelayClientTimeout = 12 * time.Second
)

// reregisterEvery bounds how often a rejected relay key is replaced.
const reregisterEvery = time.Hour

// Relay sends pushes through another gateway that holds APNs/FCM credentials
// (HONK_RELAY_SERVE). It registers lazily on the first push, keeps the
// relay_id and relay_key it gets in meta, and maps the relay's answers to the
// errors a direct pusher returns: 410 is ErrTokenGone, 429 and 5xx are
// retryable, anything else is permanent.
//
// A 401 saying the key is unknown (the relay lost its database) makes the
// Relay register again, at most once an hour and then repeat the push once. A
// 401 that says the relay is blocked does not: registering anew would only
// get around the block.
type Relay struct {
	url     string // without trailing slash
	meta    MetaStore
	version string
	client  *http.Client
	log     *slog.Logger
	// Bare leaves the bot name, title, body and group out of the request
	// (HONK_PUSH_CONTENT=none, the default for a relay).
	Bare bool

	mu             sync.Mutex
	id, key        string
	lastReregister time.Time
}

// NewRelay returns a Relay for the relay at baseURL.
func NewRelay(baseURL string, meta MetaStore, version string, log *slog.Logger) *Relay {
	return &Relay{
		url:     strings.TrimRight(baseURL, "/"),
		meta:    meta,
		version: version,
		client:  &http.Client{Timeout: RelayClientTimeout},
		log:     log,
		Bare:    true,
	}
}

// URL is the relay's base URL.
func (r *Relay) URL() string { return r.url }

type relayResponse struct {
	OK          bool            `json:"ok"`
	Result      json.RawMessage `json:"result"`
	Description string          `json:"description"`
	Parameters  struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

// credentials returns the stored relay id and key, registering first if there are none.
func (r *Relay) credentials(ctx context.Context) (string, string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.key != "" {
		return r.id, r.key, nil
	}
	url, _ := r.meta.GetMeta(ctx, metaRelayURL)
	id, _ := r.meta.GetMeta(ctx, metaRelayID)
	key, err := r.meta.GetMeta(ctx, metaRelayKey)
	if err != nil {
		return "", "", err
	}
	if key != "" && url == r.url {
		r.id, r.key = id, key
		return id, key, nil
	}
	return r.registerLocked(ctx)
}

func (r *Relay) registerLocked(ctx context.Context) (string, string, error) {
	body, _ := json.Marshal(map[string]string{"version": r.version})
	var out struct {
		ID  string `json:"relay_id"`
		Key string `json:"relay_key"`
	}
	if _, err := r.call(ctx, "/v1/relay/gateways", "", body, &out); err != nil {
		return "", "", fmt.Errorf("relay register: %w", err)
	}
	if out.ID == "" || out.Key == "" {
		return "", "", errors.New("relay register: no credentials in the answer")
	}
	for k, v := range map[string]string{metaRelayURL: r.url, metaRelayID: out.ID, metaRelayKey: out.Key} {
		if err := r.meta.SetMeta(ctx, k, v); err != nil {
			return "", "", err
		}
	}
	r.id, r.key = out.ID, out.Key
	if r.log != nil {
		r.log.Info("registered with push relay", "relay", r.url, "relay_id", out.ID)
	}
	return out.ID, out.Key, nil
}

// forget drops credentials the relay rejected; it reports whether a new
// registration may be tried now.
func (r *Relay) forget(ctx context.Context, rejected string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.key != rejected {
		return true // someone else already replaced it
	}
	if time.Since(r.lastReregister) < reregisterEvery && !r.lastReregister.IsZero() {
		return false
	}
	r.lastReregister = time.Now()
	r.id, r.key = "", ""
	_ = r.meta.SetMeta(ctx, metaRelayKey, "")
	return true
}

// call POSTs a JSON body and maps the answer. A 2xx fills out from "result".
func (r *Relay) call(ctx context.Context, path, key string, body []byte, out any) (relayResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url+path, bytes.NewReader(body))
	if err != nil {
		return relayResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	res, err := r.client.Do(req)
	if err != nil {
		return relayResponse{}, &RetryableError{Err: fmt.Errorf("relay: %w", err)}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	var rr relayResponse
	_ = json.Unmarshal(raw, &rr)
	rr.Description = strings.TrimSpace(rr.Description)
	if res.StatusCode == http.StatusOK {
		if out != nil {
			if err := json.Unmarshal(rr.Result, out); err != nil {
				return rr, fmt.Errorf("relay: bad answer: %w", err)
			}
		}
		return rr, nil
	}
	err = fmt.Errorf("relay: %d %s", res.StatusCode, rr.Description)
	switch {
	case res.StatusCode == http.StatusGone:
		return rr, ErrTokenGone
	case res.StatusCode == http.StatusTooManyRequests:
		after := time.Duration(rr.Parameters.RetryAfter) * time.Second
		if secs, e := strconv.Atoi(res.Header.Get("Retry-After")); e == nil && after == 0 {
			after = time.Duration(secs) * time.Second
		}
		return rr, &RetryableError{Err: err, After: after}
	case res.StatusCode == http.StatusServiceUnavailable && strings.Contains(rr.Description, "credentials"):
		return rr, err // the relay has no credentials for this platform: permanent
	case res.StatusCode >= 500:
		return rr, &RetryableError{Err: err}
	}
	return rr, &relayStatusError{err: err, status: res.StatusCode, desc: rr.Description}
}

type relayStatusError struct {
	err    error
	status int
	desc   string
}

func (e *relayStatusError) Error() string { return e.err.Error() }
func (e *relayStatusError) Unwrap() error { return e.err }

// Push implements Pusher.
func (r *Relay) Push(ctx context.Context, n Notification) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // "<>&" would cost six bytes each and could push a body past the relay's cap
	if err := enc.Encode(r.request(n)); err != nil {
		return err
	}
	body := buf.Bytes()
	for attempt := 0; ; attempt++ {
		_, key, err := r.credentials(ctx)
		if err != nil {
			return err
		}
		_, err = r.call(ctx, "/v1/relay/push", key, body, nil)
		var se *relayStatusError
		if attempt == 0 && errors.As(err, &se) && se.status == http.StatusUnauthorized && strings.Contains(se.desc, "unknown") {
			if r.forget(ctx, key) {
				continue
			}
		}
		if errors.As(err, &se) && se.status == http.StatusUnauthorized && r.log != nil {
			r.log.Error("push relay rejected this gateway's key", "relay", r.url, "description", se.desc)
		}
		return err
	}
}

// relayRequest is the body of POST /v1/relay/push.
type relayRequest struct {
	Platform    string `json:"platform"`
	Token       string `json:"token"`
	Kind        string `json:"kind"`
	MsgID       int64  `json:"msg_id"`
	TargetID    int64  `json:"target_id,omitempty"`
	BotID       string `json:"bot_id"`
	Level       string `json:"level,omitempty"`
	CollapseKey string `json:"collapse_key,omitempty"`
	BotName     string `json:"bot_name,omitempty"`
	Title       string `json:"title,omitempty"`
	Body        string `json:"body,omitempty"`
	Group       string `json:"group,omitempty"`
	// Silent sends a message as a silent push (no banner); TTL is how many
	// seconds APNs/FCM may keep the push for an offline device (0: their default).
	Silent bool `json:"silent,omitempty"`
	TTL    int  `json:"ttl,omitempty"`
}

func (r *Relay) request(n Notification) relayRequest {
	q := relayRequest{
		Platform: n.Platform, Token: n.Token, Kind: n.Kind, MsgID: n.MessageID, TargetID: n.TargetID,
		BotID: n.BotID, Level: n.Level, CollapseKey: CollapseKeyFor(n.BotID, n.CollapseID),
	}
	q.Silent = n.Quiet
	if !n.Expires.IsZero() {
		q.TTL = int(n.pushTTL() / time.Second)
	}
	if !r.Bare && !n.Silent() {
		q.BotName = truncate(n.BotName, 256)
		q.Title = truncate(n.Title, 200)
		q.Body = truncate(n.Body, maxBannerBody)
		q.Group = truncate(n.Group, 256)
	}
	return q
}
