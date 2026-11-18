// Package client is the sender side of Honk: the HTTP client for the bot API,
// the end-to-end encryption of message content, and the command line behind
// `honk send`, `honk edit`, `honk delete`, `honk me` and `honk preview`.
package client

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config says which gateway and bot to talk to.
type Config struct {
	URL   string `json:"url"`   // gateway base URL, e.g. https://honk.example.com
	Token string `json:"token"` // bot token, <bot id>:<secret>
	Key   string `json:"key"`   // optional base64 end-to-end key for --key
}

// ConfigPath is the config file: $HONK_CONFIG, else
// $XDG_CONFIG_HOME/honk/config.json, else ~/.config/honk/config.json.
func ConfigPath(getenv func(string) string) string {
	if p := getenv("HONK_CONFIG"); p != "" {
		return p
	}
	if x := getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "honk", "config.json")
	}
	if h := getenv("HOME"); h != "" {
		return filepath.Join(h, ".config", "honk", "config.json")
	}
	return ""
}

// LoadConfig reads the config file (a missing file is fine) and lets
// HONK_URL, HONK_TOKEN and HONK_KEY override it.
func LoadConfig(getenv func(string) string) (Config, error) {
	var c Config
	if p := ConfigPath(getenv); p != "" {
		b, err := os.ReadFile(p)
		switch {
		case err == nil:
			if err := json.Unmarshal(b, &c); err != nil {
				return c, fmt.Errorf("%s: %w", p, err)
			}
		case !errors.Is(err, os.ErrNotExist):
			return c, err
		}
	}
	if v := getenv("HONK_URL"); v != "" {
		c.URL = v
	}
	if v := getenv("HONK_TOKEN"); v != "" {
		c.Token = v
	}
	if v := getenv("HONK_KEY"); v != "" {
		c.Key = v
	}
	return c, nil
}

// Client calls one bot's API.
type Client struct {
	URL   string
	Token string
	HTTP  *http.Client
}

// APIError is a failure the gateway reported.
type APIError struct {
	Code        int
	Description string
}

func (e *APIError) Error() string {
	if e.Code != 0 {
		return fmt.Sprintf("%s (%d)", e.Description, e.Code)
	}
	return e.Description
}

// Call posts params as a JSON body to /bot<token>/<method> and returns the
// raw "result". A failed envelope becomes an *APIError carrying the
// gateway's description.
func (c *Client) Call(ctx context.Context, method string, params map[string]string) (json.RawMessage, error) {
	if c.URL == "" {
		return nil, errors.New("no gateway URL: set HONK_URL, --server or the config file")
	}
	if c.Token == "" {
		return nil, errors.New("no bot token: set HONK_TOKEN, --token or the config file")
	}
	b, _ := json.Marshal(params)
	endpoint := strings.TrimRight(c.URL, "/") + "/bot" + c.Token + "/" + method
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	res, err := hc.Do(req)
	if err != nil {
		// The URL holds the token; do not echo it.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	var env struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		ErrorCode   int             `json:"error_code"`
		Description string          `json:"description"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("not a Honk gateway answer (HTTP %d)", res.StatusCode)
	}
	if !env.OK {
		return nil, &APIError{Code: env.ErrorCode, Description: env.Description}
	}
	return env.Result, nil
}

// ---- end-to-end encryption (design §7.3) ----

// Encrypt seals plaintext with AES-256-GCM. The result is the base64url
// (unpadded) text of nonce(12) || ciphertext || tag(16), with aad (the bot's
// short id) authenticated.
func Encrypt(key []byte, aad string, plaintext []byte) (string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, plaintext, []byte(aad))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

// Decrypt reverses Encrypt (padded or unpadded base64url).
func Decrypt(key []byte, aad, text string) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(text, "="))
	if err != nil {
		return nil, fmt.Errorf("ciphertext is not base64url: %w", err)
	}
	if len(raw) < gcm.NonceSize()+gcm.Overhead() {
		return nil, errors.New("ciphertext too short")
	}
	return gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], []byte(aad))
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// ParseKey decodes a base64 (standard or URL alphabet, padded or not) key.
func ParseKey(s string) ([]byte, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	s = strings.NewReplacer("+", "-", "/", "_").Replace(s)
	k, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("key is not base64: %w", err)
	}
	if len(k) != 32 {
		return nil, fmt.Errorf("key must be 32 bytes, got %d", len(k))
	}
	return k, nil
}

// BotID is the short id in front of the colon of a bot token; the
// encryption uses it as AAD.
func BotID(token string) string {
	id, _, _ := strings.Cut(token, ":")
	return id
}
