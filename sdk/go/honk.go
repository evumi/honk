// Package honk is the Go SDK for the Honk Bot API: send, edit and delete
// push messages through a Honk gateway, seal them end to end when the bot is
// encrypted, and answer the widget queries that cards send with request().
//
//	c := &honk.Client{URL: "https://honk.example.com", Token: "aZ3kQ9xT:Gw2K7mx…"}
//	_, err := c.Send(ctx, honk.Message{Title: "Deploy", Body: "api v1.8.2 is live"})
//
// With Client.Key set, the content of every message is encrypted on this side
// (AES-256-GCM, the bot's short id as AAD) and the gateway only sees the
// ciphertext. The import path is github.com/evumi/honk/sdk/go; the package
// name is honk.
package honk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime/debug"
	"strings"
	"time"
)

const modulePath = "github.com/evumi/honk/sdk/go"

// Version is the SDK's version, without the leading v. It comes from the
// module version the program was built with (releases are the repository's
// vX.Y.Z tags), or "dev" when there is none, as in the SDK's own tests or a
// replace with a local path.
var Version = moduleVersion()

func moduleVersion() string {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}
	mods := append([]*debug.Module{&bi.Main}, bi.Deps...)
	for _, m := range mods {
		if m == nil || m.Path != modulePath {
			continue
		}
		if m.Replace != nil {
			m = m.Replace
		}
		if v := strings.TrimPrefix(m.Version, "v"); v != "" && v != "(devel)" {
			return v
		}
		break
	}
	return "dev"
}

// Client calls one bot's API. The zero value is not usable: set URL and
// Token. A Client is safe for concurrent use once it is set up.
type Client struct {
	// URL is the gateway's base URL, e.g. https://honk.example.com.
	URL string
	// Token is the bot token, <bot id>:<secret>.
	Token string
	// Key is the bot's 32-byte end-to-end key (see ParseKey). When set,
	// message content is sent as ciphertext; it is required once the bot has
	// end-to-end encryption turned on.
	Key []byte
	// HTTP is the client used for requests; nil means a default one. Its own
	// Timeout should be zero or longer than a long poll (60 s).
	HTTP *http.Client
	// Timeout bounds each call that is not a long poll; zero means 30 s.
	Timeout time.Duration
	// Retries is how many times a call refused with 429 Too Many Requests is
	// tried again, after 1 s, 2 s, 4 s, … (at most 30 s). Zero: no retries.
	Retries int
}

// FromEnv makes a Client from HONK_URL, HONK_TOKEN and the optional HONK_KEY.
func FromEnv() (*Client, error) {
	c := &Client{URL: os.Getenv("HONK_URL"), Token: os.Getenv("HONK_TOKEN")}
	if c.URL == "" || c.Token == "" {
		return nil, errors.New("honk: HONK_URL and HONK_TOKEN must be set")
	}
	if k := os.Getenv("HONK_KEY"); k != "" {
		key, err := ParseKey(k)
		if err != nil {
			return nil, fmt.Errorf("honk: HONK_KEY: %w", err)
		}
		c.Key = key
	}
	return c, nil
}

// BotID is the bot's short id, the part of the token before the colon.
func (c *Client) BotID() string {
	id, _, _ := strings.Cut(c.Token, ":")
	return id
}

// Error is a failure the gateway reported: Code is its error_code (the HTTP
// status, e.g. 400, 401, 409, 429) and Description its description.
type Error struct {
	Code        int
	Description string
}

func (e *Error) Error() string {
	return fmt.Sprintf("honk: %s (%d)", e.Description, e.Code)
}

// IsCode reports whether err is an *Error with the given code.
func IsCode(err error, code int) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == code
}

const defaultTimeout = 30 * time.Second

var defaultHTTP = &http.Client{}

// call posts params as JSON to /bot<token>/<method> and decodes "result"
// into out (when out is not nil). wait is how long the gateway may hold the
// request on purpose (a long poll), added to the timeout.
func (c *Client) call(ctx context.Context, method string, params map[string]any, out any, wait time.Duration) error {
	if c.URL == "" || c.Token == "" {
		return errors.New("honk: Client needs URL and Token")
	}
	body, err := marshal(params)
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		raw, err := c.post(ctx, method, body, wait)
		if err == nil {
			if out == nil {
				return nil
			}
			if err := json.Unmarshal(raw, out); err != nil {
				return fmt.Errorf("honk: %s: unexpected result: %w", method, err)
			}
			return nil
		}
		if !IsCode(err, http.StatusTooManyRequests) || attempt >= c.Retries {
			return err
		}
		delay := min(time.Second<<attempt, 30*time.Second)
		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return err
		case <-t.C:
		}
	}
}

func (c *Client) post(ctx context.Context, method string, body []byte, wait time.Duration) (json.RawMessage, error) {
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout+wait)
	defer cancel()
	endpoint := strings.TrimRight(c.URL, "/") + "/bot" + c.Token + "/" + method
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("honk: %s: %w", method, redact(err))
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "honk-go/"+Version)
	hc := c.HTTP
	if hc == nil {
		hc = defaultHTTP
	}
	res, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("honk: %s: %w", method, redact(err))
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("honk: %s: %w", method, err)
	}
	var env struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		ErrorCode   int             `json:"error_code"`
		Description string          `json:"description"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("honk: %s: not a Honk gateway answer (HTTP %d)", method, res.StatusCode)
	}
	if !env.OK {
		code := env.ErrorCode
		if code == 0 {
			code = res.StatusCode
		}
		return nil, &Error{Code: code, Description: env.Description}
	}
	return env.Result, nil
}

// marshal writes JSON without escaping <, > and &, so cards stay small.
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, fmt.Errorf("honk: %w", err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// redact drops the request URL, which holds the token, from a transport error.
func redact(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
