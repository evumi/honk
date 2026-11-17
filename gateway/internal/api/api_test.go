package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/evumi/honk/gateway/internal/push"
	"github.com/evumi/honk/gateway/internal/store"
)

type fakePusher struct {
	mu    sync.Mutex
	sent  []push.Notification
	err   error
	block chan struct{} // when set, Push waits for it to close
}

func (f *fakePusher) Push(_ context.Context, n push.Notification) error {
	f.mu.Lock()
	block := f.block
	f.mu.Unlock()
	if block != nil {
		<-block
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, n)
	return f.err
}

func (f *fakePusher) last(t *testing.T) push.Notification {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sent) == 0 {
		t.Fatal("nothing was pushed")
	}
	return f.sent[len(f.sent)-1]
}

type env struct {
	t      *testing.T
	s      *Server
	srv    *httptest.Server
	pusher *fakePusher
}

func setup(t *testing.T) *env {
	return setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3})
}

func setupWith(t *testing.T, opts Options) *env {
	st, err := store.Open(filepath.Join(t.TempDir(), "honk.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	p := &fakePusher{}
	s := New(st, p, slog.New(slog.NewTextHandler(io.Discard, nil)), opts)
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &env{t: t, s: s, srv: srv, pusher: p}
}

type envelope struct {
	OK          bool            `json:"ok"`
	Result      json.RawMessage `json:"result"`
	ErrorCode   int             `json:"error_code"`
	Description string          `json:"description"`
}

func (e *env) do(method, path, secret string, body any) envelope {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	return e.send(req)
}

func (e *env) send(req *http.Request) envelope {
	e.t.Helper()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	// Pushes run in the background; let them finish so tests can look at them.
	e.s.Wait()
	var out envelope
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		e.t.Fatalf("%s %s: bad JSON: %v", req.Method, req.URL.Path, err)
	}
	if !out.OK && out.ErrorCode != res.StatusCode {
		e.t.Errorf("error_code %d != status %d", out.ErrorCode, res.StatusCode)
	}
	return out
}

func must[T any](t *testing.T, r envelope) T {
	t.Helper()
	if !r.OK {
		t.Fatalf("request failed: %d %s", r.ErrorCode, r.Description)
	}
	var v T
	if err := json.Unmarshal(r.Result, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// register makes a device with one bot and returns the device secret and the bot token.
func (e *env) register(platform string) (string, string) {
	reg := must[struct {
		Secret string `json:"device_secret"`
	}](e.t, e.do("POST", "/v1/devices", "", map[string]string{"platform": platform, "push_token": "tok-" + platform}))
	bot := must[struct {
		Token string `json:"token"`
	}](e.t, e.do("POST", "/v1/bots", reg.Secret, map[string]string{"name": "Berth 部署", "default_level": "active"}))
	return reg.Secret, bot.Token
}

func TestSendFetchSyncAck(t *testing.T) {
	e := setup(t)
	secret, token := e.register("ios")

	card := `<div><span>{{status}}</span><script>x()</script><a href="{{url}}">查看</a></div>`
	sent := must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{
		"title": "部署成功", "body": "sub2api / sluice 已上线", "html": card,
		"data": map[string]string{"status": "已上线"}, "level": "time-sensitive", "id": "dep-1",
	}))
	if sent.ID == 0 || strings.Contains(sent.HTML, "script") || sent.Data != `{"status":"已上线"}` || sent.Level != "timeSensitive" {
		t.Fatalf("sent = %+v", sent)
	}
	n := e.pusher.last(t)
	if n.Platform != "ios" || n.Token != "tok-ios" || n.MessageID != sent.ID || n.BotName != "Berth 部署" || n.Silent() {
		t.Errorf("push = %+v", n)
	}

	got := must[store.Message](t, e.do("GET", fmt.Sprintf("/v1/messages/%d", sent.ID), secret, nil))
	if got.HTML != sent.HTML || got.Title != "部署成功" {
		t.Errorf("fetched = %+v", got)
	}

	must[bool](t, e.do("POST", "/bot"+token+"/editMessageData", "", map[string]any{"id": "dep-1", "data": `{"status":"已回滚"}`}))
	if n := e.pusher.last(t); n.Kind != "edit" || n.TargetID != sent.ID || !n.Silent() {
		t.Errorf("edit push = %+v", n)
	}

	page := must[struct {
		Messages []store.Message `json:"messages"`
		Cursor   int64           `json:"cursor"`
	}](t, e.do("GET", "/v1/sync?cursor=0", secret, nil))
	if len(page.Messages) != 2 || page.Messages[0].Data != `{"status":"已回滚"}` || page.Messages[1].Kind != "edit" {
		t.Fatalf("sync = %+v", page)
	}
	acked := must[struct {
		Acked int64 `json:"acked"`
	}](t, e.do("POST", "/v1/ack", secret, map[string]int64{"up_to": page.Cursor}))
	if acked.Acked != 2 {
		t.Errorf("acked %d", acked.Acked)
	}
}

func TestBotAPIParamForms(t *testing.T) {
	e := setup(t)
	_, token := e.register("android")

	// GET with query parameters, like Bark.
	r := e.do("GET", "/bot"+token+"/sendMessage?body="+url.QueryEscape("来自 GET"), "", nil)
	if m := must[store.Message](t, r); m.Body != "来自 GET" {
		t.Errorf("GET body = %q", m.Body)
	}
	// Form body.
	req, _ := http.NewRequest("POST", e.srv.URL+"/bot"+token+"/sendMessage", strings.NewReader("body=form&level=passive"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if m := must[store.Message](t, e.send(req)); m.Body != "form" || m.Level != "passive" {
		t.Errorf("form = %+v", m)
	}
	if n := e.pusher.last(t); n.Platform != "android" || n.Level != "passive" {
		t.Errorf("push = %+v", n)
	}
	// getMe.
	if b := must[store.Bot](t, e.do("GET", "/bot"+token+"/getMe", "", nil)); b.Name != "Berth 部署" {
		t.Errorf("getMe = %+v", b)
	}
}

func TestBotAPIErrors(t *testing.T) {
	e := setup(t)
	_, token := e.register("ios")
	cases := []struct {
		name string
		path string
		body any
		code int
	}{
		{"bad token", "/bot1:nope/sendMessage", map[string]string{"body": "x"}, 401},
		{"no body", "/bot" + token + "/sendMessage", map[string]string{"title": "x"}, 400},
		{"bad level", "/bot" + token + "/sendMessage", map[string]string{"body": "x", "level": "loud"}, 400},
		{"http icon", "/bot" + token + "/sendMessage", map[string]string{"body": "x", "icon": "http://a/b.png"}, 400},
		{"big data", "/bot" + token + "/sendMessage", map[string]string{"body": "x", "data": strings.Repeat("a", 1025)}, 400},
		{"big html", "/bot" + token + "/sendMessage", map[string]string{"body": "x", "html": strings.Repeat("a", 33*1024)}, 400},
		{"no target", "/bot" + token + "/editMessageData", map[string]string{"data": "x"}, 400},
		{"unknown method", "/bot" + token + "/sendSticker", map[string]string{}, 404},
		{"not a bot path", "/foo/bar", nil, 404},
	}
	for _, c := range cases {
		r := e.do("POST", c.path, "", c.body)
		if r.OK || r.ErrorCode != c.code {
			t.Errorf("%s: got ok=%v code=%d %s, want %d", c.name, r.OK, r.ErrorCode, r.Description, c.code)
		}
	}
	if r := e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x", "html": strings.Repeat("a", 33*1024)}); !strings.Contains(r.Description, "WIDGET_TOO_LARGE") {
		t.Errorf("widget error code missing: %s", r.Description)
	}
}

func TestRateLimit(t *testing.T) {
	e := setup(t) // burst 3
	_, token := e.register("ios")
	var limited bool
	for i := 0; i < 10; i++ {
		if r := e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x"}); r.ErrorCode == 429 {
			limited = true
		}
	}
	if !limited {
		t.Error("10 quick sends were never limited")
	}
}

func TestAppAuthAndOwnership(t *testing.T) {
	e := setup(t)
	a, tokenA := e.register("ios")
	b, _ := e.register("android")

	if r := e.do("GET", "/v1/bots", "", nil); r.ErrorCode != 401 {
		t.Errorf("no secret: %d", r.ErrorCode)
	}
	bots := must[[]store.Bot](t, e.do("GET", "/v1/bots", a, nil))
	if len(bots) != 1 {
		t.Fatalf("bots = %+v", bots)
	}
	id := bots[0].ID
	sent := must[store.Message](t, e.do("POST", "/bot"+tokenA+"/sendMessage", "", map[string]string{"body": "x"}))
	if r := e.do("GET", fmt.Sprintf("/v1/messages/%d", sent.ID), b, nil); r.ErrorCode != 404 {
		t.Errorf("other device read message: %d", r.ErrorCode)
	}
	if r := e.do("DELETE", fmt.Sprintf("/v1/bots/%d", id), b, nil); r.ErrorCode != 404 {
		t.Errorf("other device deleted bot: %d", r.ErrorCode)
	}

	renamed := must[store.Bot](t, e.do("PATCH", fmt.Sprintf("/v1/bots/%d", id), a, map[string]string{"name": "CI"}))
	if renamed.Name != "CI" || renamed.DefaultLevel != "active" {
		t.Errorf("patched = %+v", renamed)
	}
	reset := must[struct {
		Token string `json:"token"`
	}](t, e.do("POST", fmt.Sprintf("/v1/bots/%d/token", id), a, nil))
	if r := e.do("GET", "/bot"+tokenA+"/getMe", "", nil); r.ErrorCode != 401 {
		t.Errorf("old token after reset: %d", r.ErrorCode)
	}
	must[store.Bot](t, e.do("GET", "/bot"+reset.Token+"/getMe", "", nil))
}

func TestGoneTokenStopsPushes(t *testing.T) {
	e := setup(t)
	secret, token := e.register("ios")
	e.pusher.err = push.ErrTokenGone
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "1"}))
	e.pusher.err = nil
	before := len(e.pusher.sent)
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "2"}))
	if len(e.pusher.sent) != before {
		t.Error("pushed to a token APNs reported gone")
	}
	// A new token from the app turns pushes back on.
	must[store.Device](t, e.do("PUT", "/v1/devices/me", secret, map[string]string{"push_token": "tok-new"}))
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "3"}))
	if n := e.pusher.last(t); n.Token != "tok-new" {
		t.Errorf("push went to %q", n.Token)
	}
}

func TestInfo(t *testing.T) {
	e := setup(t)
	info := must[map[string]any](t, e.do("GET", "/v1/info", "", nil))
	if info["name"] != "honk" || info["api"] != float64(1) {
		t.Errorf("info = %v", info)
	}
}

func TestSimulatorTokenGetsNoPush(t *testing.T) {
	e := setup(t)
	reg := must[struct {
		Secret string `json:"device_secret"`
	}](t, e.do("POST", "/v1/devices", "", map[string]string{"platform": "ios", "push_token": SimulatorTokenPrefix + "abc"}))
	bot := must[struct {
		Token string `json:"token"`
	}](t, e.do("POST", "/v1/bots", reg.Secret, map[string]string{"name": "sim"}))
	sent := must[store.Message](t, e.do("POST", "/bot"+bot.Token+"/sendMessage", "", map[string]string{"body": "x"}))
	if len(e.pusher.sent) != 0 {
		t.Errorf("pushed to a simulator token: %+v", e.pusher.sent)
	}
	// The message still syncs.
	page := must[struct {
		Messages []store.Message `json:"messages"`
	}](t, e.do("GET", "/v1/sync", reg.Secret, nil))
	if len(page.Messages) != 1 || page.Messages[0].ID != sent.ID {
		t.Errorf("sync = %+v", page.Messages)
	}
}

func TestRegistrationIsRateLimitedPerIP(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, RegisterPerHour: 1, RegisterBurst: 2})
	body := map[string]string{"platform": "ios", "push_token": "t"}
	for i := 0; i < 2; i++ {
		must[map[string]any](t, e.do("POST", "/v1/devices", "", body))
	}
	if r := e.do("POST", "/v1/devices", "", body); r.ErrorCode != 429 {
		t.Errorf("third registration from one IP: %d %s", r.ErrorCode, r.Description)
	}
}

func TestBotsPerDeviceAreCapped(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, MaxBotsPerDevice: 2})
	secret, _ := e.register("ios") // one bot
	must[map[string]any](t, e.do("POST", "/v1/bots", secret, map[string]string{"name": "two"}))
	if r := e.do("POST", "/v1/bots", secret, map[string]string{"name": "three"}); r.ErrorCode != 400 {
		t.Errorf("third bot: %d %s", r.ErrorCode, r.Description)
	}
}

func TestPushDoesNotHoldTheResponse(t *testing.T) {
	e := setup(t)
	_, token := e.register("ios")
	block := make(chan struct{})
	e.pusher.mu.Lock()
	e.pusher.block = block
	e.pusher.mu.Unlock()
	done := make(chan envelope, 1)
	go func() {
		req, _ := http.NewRequest("POST", e.srv.URL+"/bot"+token+"/sendMessage", strings.NewReader(`{"body":"x"}`))
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Error(err)
			return
		}
		defer res.Body.Close()
		var out envelope
		_ = json.NewDecoder(res.Body).Decode(&out)
		done <- out
	}()
	select {
	case r := <-done:
		if !r.OK {
			t.Errorf("send failed: %s", r.Description)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("sendMessage waited for the push")
	}
	close(block)
	e.s.Wait()
	if n := e.pusher.last(t); n.Body != "x" {
		t.Errorf("push = %+v", n)
	}
}

func TestPruneLimiters(t *testing.T) {
	e := setup(t)
	secret, token := e.register("ios")
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x"}))
	if n := e.s.PruneLimiters(time.Hour); n != 0 {
		t.Errorf("pruned %d fresh limiters", n)
	}
	if n := e.s.PruneLimiters(0); n != 2 { // the bot's and the registering IP's
		t.Errorf("pruned %d idle limiters, want 2", n)
	}
	// Deleting a bot drops its limiter at once.
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "y"}))
	bots := must[[]store.Bot](t, e.do("GET", "/v1/bots", secret, nil))
	must[bool](t, e.do("DELETE", fmt.Sprintf("/v1/bots/%d", bots[0].ID), secret, nil))
	e.s.mu.Lock()
	_, kept := e.s.limiters[bots[0].ID]
	e.s.mu.Unlock()
	if kept {
		t.Error("deleted bot's limiter kept")
	}
}
