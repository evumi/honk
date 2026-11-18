package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/evumi/honk/gateway/internal/push"
	"github.com/evumi/honk/gateway/internal/store"
)

// relayEnv is a relay server (with fake APNs and FCM behind it) and a
// self-hosted gateway whose pushes go to it.
type relayEnv struct {
	relay      *env
	apns, fcm  *fakePusher
	home       *env // the self-hosted gateway
	client     *push.Relay
	secret     string // home device secret
	token      string // home bot token
	relayStore *store.Store
}

func newRelayEnv(t *testing.T, bare bool, homeOpts Options) *relayEnv {
	t.Helper()
	apns, fcm := &fakePusher{}, &fakePusher{}
	relay := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, RelayServe: true, RelayAPNs: apns, RelayFCM: fcm})
	homeOpts.MessageTTL, homeOpts.SendRate, homeOpts.SendBurst = time.Hour, 1000, 100
	homeOpts.PushIOS, homeOpts.PushAndroid = "relay", "relay"
	home := setupWith(t, homeOpts)
	client := push.NewRelay(relay.srv.URL+"/", home.s.store, "test", slog.New(slog.NewTextHandler(io.Discard, nil)))
	client.Bare = bare
	home.s.pusher = push.Router{APNs: client, FCM: client}
	secret, token := home.register("ios")
	return &relayEnv{relay: relay, apns: apns, fcm: fcm, home: home, client: client, secret: secret, token: token, relayStore: relay.s.store}
}

func (r *relayEnv) send(body map[string]any) {
	r.home.t.Helper()
	must[store.Message](r.home.t, r.home.do("POST", "/bot"+r.token+"/sendMessage", "", body))
}

func (r *relayEnv) pushOK() bool {
	r.home.t.Helper()
	d := must[store.Device](r.home.t, r.home.do("GET", "/v1/devices/me", r.secret, nil))
	return d.PushOK
}

func TestRelayChainSendsNoContentByDefault(t *testing.T) {
	r := newRelayEnv(t, true, Options{})
	r.send(map[string]any{"title": "部署成功", "body": "秘密正文", "id": "dep-1", "group": "prod", "level": "time-sensitive"})
	n := r.apns.last(t)
	if n.Platform != "ios" || n.Token != "tok-ios" || n.Kind != "message" || n.MessageID == 0 || n.Level != "timeSensitive" || !n.Bare {
		t.Fatalf("relayed push = %+v", n)
	}
	if n.BotName != "" || n.Title != "" || n.Body != "" || n.Group != "" || n.CollapseID != "" {
		t.Errorf("content reached the relay: %+v", n)
	}
	if n.CollapseKey != push.CollapseKeyFor(n.BotID, "dep-1") || strings.Contains(n.CollapseKey, "dep-1") {
		t.Errorf("collapse key = %q", n.CollapseKey)
	}
	if got := r.home.s.m.pushes.Value("ios", "relay", "ok"); got != 1 {
		t.Errorf("home relay ok = %d", got)
	}
	if got := r.relay.s.m.relayPushes.Value("ios"); got != 1 {
		t.Errorf("relay pushes = %d", got)
	}
	// One registration, kept in meta; a second push does not register again.
	id, _ := r.home.s.store.GetMeta(context.Background(), "relay_id")
	if id == "" {
		t.Fatal("relay id not stored")
	}
	r.send(map[string]any{"body": "again"})
	if got := r.relay.s.m.relayReqs.Value("registered"); got != 1 {
		t.Errorf("registrations = %d", got)
	}
	if len(r.apns.sent) != 2 {
		t.Errorf("relayed pushes = %d", len(r.apns.sent))
	}
}

func TestRelayChainFullContent(t *testing.T) {
	r := newRelayEnv(t, false, Options{})
	r.send(map[string]any{"title": "T", "body": "B"})
	n := r.apns.last(t)
	if n.Bare || n.BotName != "Berth 部署" || n.Title != "T" || n.Body != "B" {
		t.Errorf("full relayed push = %+v", n)
	}
}

func TestRelayEditAndDeleteAreSilent(t *testing.T) {
	r := newRelayEnv(t, false, Options{})
	r.send(map[string]any{"body": "x", "id": "k"})
	must[bool](t, r.home.do("POST", "/bot"+r.token+"/editMessageData", "", map[string]any{"id": "k", "data": `{"a":1}`}))
	n := r.apns.last(t)
	if n.Kind != "edit" || !n.Silent() || n.TargetID == 0 {
		t.Errorf("edit push = %+v", n)
	}
}

func TestRelayTokenGoneMarksDevice(t *testing.T) {
	r := newRelayEnv(t, true, Options{})
	r.apns.err = push.ErrTokenGone
	if !r.pushOK() {
		t.Fatal("push_ok starts false")
	}
	r.send(map[string]any{"body": "x"})
	if r.pushOK() {
		t.Error("push_ok still 1 after the relay said 410")
	}
	if got := r.home.s.m.pushes.Value("ios", "relay", "token_gone"); got != 1 {
		t.Errorf("token_gone = %d", got)
	}
	if got := r.relay.s.m.relayReqs.Value("token_gone"); got != 1 {
		t.Errorf("relay token_gone = %d", got)
	}
}

func TestRelayRetryAfterIsHonouredByTheRetryQueue(t *testing.T) {
	r := newRelayEnv(t, true, Options{PushBackoff: []time.Duration{time.Millisecond}})
	// APNs asks for 100 ms: the relay turns it into a 429 with retry_after 1.
	r.apns.err = &push.RetryableError{Err: io.ErrUnexpectedEOF, After: 100 * time.Millisecond}
	start := time.Now()
	r.send(map[string]any{"body": "x"})
	r.apns.mu.Lock()
	r.apns.err = nil
	r.apns.mu.Unlock()
	waitFor(t, "second relayed push", func() bool {
		r.apns.mu.Lock()
		defer r.apns.mu.Unlock()
		return len(r.apns.sent) == 2
	})
	if d := time.Since(start); d < 950*time.Millisecond {
		t.Errorf("retried after %v, want at least the 1 s retry_after", d)
	}
	waitFor(t, "ok counted", func() bool { return r.home.s.m.pushes.Value("ios", "relay", "ok") == 1 })
}

func TestRelayWithoutCredentialsIsPermanentAndNeverForwards(t *testing.T) {
	// The relay has an FCM pusher only. Its own s.pusher stands for the router
	// that could lead to another relay: it must never be used.
	other := &fakePusher{}
	fcm := &fakePusher{}
	relay := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, RelayServe: true, RelayFCM: fcm})
	relay.s.pusher = other
	home := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 1000, SendBurst: 100, PushIOS: "relay", PushBackoff: []time.Duration{time.Millisecond}})
	client := push.NewRelay(relay.srv.URL, home.s.store, "test", nil)
	home.s.pusher = push.Router{APNs: client, FCM: client}
	_, token := home.register("ios")
	must[store.Message](t, home.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{"body": "x"}))
	if len(other.sent) != 0 || len(fcm.sent) != 0 {
		t.Errorf("relay forwarded: %d, %d", len(other.sent), len(fcm.sent))
	}
	if got := relay.s.m.relayReqs.Value("no_credentials"); got != 1 {
		t.Errorf("no_credentials = %d (retried?)", got)
	}
	if got := home.s.m.pushes.Value("ios", "relay", "failed"); got != 1 {
		t.Errorf("home failed = %d, want 1 and no retry", got)
	}
	// A gateway that does not serve has no relay endpoints at all.
	res, _ := http.Post(home.srv.URL+"/v1/relay/push", "application/json", strings.NewReader("{}"))
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("non-relay /v1/relay/push = %d", res.StatusCode)
	}
}

func relayCall(t *testing.T, base, path, key string, body any) (int, map[string]any, http.Header) {
	t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case []byte:
		rd = bytes.NewReader(b)
	default:
		raw, _ := json.Marshal(b)
		rd = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest("POST", base+path, rd)
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out, res.Header
}

func registerRelayKey(t *testing.T, e *env) (string, string) {
	t.Helper()
	code, out, _ := relayCall(t, e.srv.URL, "/v1/relay/gateways", "", map[string]string{"version": "x"})
	res, _ := out["result"].(map[string]any)
	if code != 200 || res["relay_id"] == "" || res["relay_key"] == "" {
		t.Fatalf("register = %d %v", code, out)
	}
	return res["relay_id"].(string), res["relay_key"].(string)
}

var goodPush = map[string]any{"platform": "ios", "token": "t1", "kind": "message", "msg_id": 5, "bot_id": "Kx3abcde", "level": "active"}

func TestRelayRegistrationAuthAndValidation(t *testing.T) {
	fp := &fakePusher{}
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 1, SendBurst: 1, RelayServe: true, RelayAPNs: fp, RegisterBurst: 3})
	id, key := registerRelayKey(t, e)

	if code, _, _ := relayCall(t, e.srv.URL, "/v1/relay/push", "", goodPush); code != 401 {
		t.Errorf("no key: %d", code)
	}
	if code, out, _ := relayCall(t, e.srv.URL, "/v1/relay/push", "wrong", goodPush); code != 401 || !strings.Contains(out["description"].(string), "unknown") {
		t.Errorf("bad key: %d %v", code, out)
	}
	if code, out, _ := relayCall(t, e.srv.URL, "/v1/relay/push", key, goodPush); code != 200 || out["ok"] != true {
		t.Fatalf("good push: %d %v", code, out)
	}

	bad := func(mut func(m map[string]any)) int {
		m := map[string]any{}
		for k, v := range goodPush {
			m[k] = v
		}
		mut(m)
		c, _, _ := relayCall(t, e.srv.URL, "/v1/relay/push", key, m)
		return c
	}
	for name, mut := range map[string]func(map[string]any){
		"platform": func(m map[string]any) { m["platform"] = "web" },
		"token":    func(m map[string]any) { m["token"] = "" },
		"kind":     func(m map[string]any) { m["kind"] = "x" },
		"msg_id":   func(m map[string]any) { m["msg_id"] = 0 },
		"bot_id":   func(m map[string]any) { m["bot_id"] = "12" },
		"level":    func(m map[string]any) { m["level"] = "loud" },
		"collapse": func(m map[string]any) { m["collapse_key"] = strings.Repeat("a", 65) },
	} {
		if c := bad(mut); c != 400 {
			t.Errorf("%s: %d, want 400", name, c)
		}
	}
	if code, _, _ := relayCall(t, e.srv.URL, "/v1/relay/push", key, []byte("{nope")); code != 400 {
		t.Errorf("bad JSON: %d", code)
	}
	huge := map[string]any{"platform": "ios", "token": "t", "kind": "message", "msg_id": 1, "bot_id": "Kx3abcde", "body": strings.Repeat("x", 9000)}
	if code, _, _ := relayCall(t, e.srv.URL, "/v1/relay/push", key, huge); code != 413 {
		t.Errorf("over 8 KB: %d", code)
	}
	// No FCM credentials on this relay.
	if code, _, _ := relayCall(t, e.srv.URL, "/v1/relay/push", key, map[string]any{"platform": "android", "token": "t", "kind": "message", "msg_id": 1, "bot_id": "Kx3abcde"}); code != 503 {
		t.Errorf("no credentials: %d", code)
	}

	// Blocked relays are refused.
	if err := e.s.store.BlockRelay(context.Background(), id, true); err != nil {
		t.Fatal(err)
	}
	if code, out, _ := relayCall(t, e.srv.URL, "/v1/relay/push", key, goodPush); code != 401 || !strings.Contains(out["description"].(string), "blocked") {
		t.Errorf("blocked: %d %v", code, out)
	}
	if e.s.m.relayReqs.Value("blocked") != 1 {
		t.Error("blocked not counted")
	}

	// Registration is rate limited per IP: burst 3, two done so far (the first
	// and the one below), the next refused.
	registerRelayKey(t, e)
	registerRelayKey(t, e)
	if code, _, h := relayCall(t, e.srv.URL, "/v1/relay/gateways", "", map[string]string{}); code != 429 || h.Get("Retry-After") == "" {
		t.Errorf("4th registration: %d", code)
	}
}

func TestRelayRateLimits(t *testing.T) {
	fp := &fakePusher{}
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 1, SendBurst: 1, RelayServe: true, RelayAPNs: fp, RelayRate: 0.001, RelayBurst: 4, RelayTokenPerMinute: 2})
	_, key := registerRelayKey(t, e)
	push := func(tok string) (int, map[string]any) {
		m := map[string]any{"platform": "ios", "token": tok, "kind": "message", "msg_id": 1, "bot_id": "Kx3abcde"}
		c, out, _ := relayCall(t, e.srv.URL, "/v1/relay/push", key, m)
		return c, out
	}
	// The token bucket (2 per minute) runs out first for one token ...
	push("a")
	push("a")
	code, out := push("a")
	params, _ := out["parameters"].(map[string]any)
	if code != 429 || params["retry_after"] == nil {
		t.Errorf("per-token limit: %d %v", code, out)
	}
	// ... another token still works, until the relay's own bucket (burst 4) is empty.
	if code, _ := push("b"); code != 200 {
		t.Errorf("other token: %d", code)
	}
	code, out = push("c")
	if code != 429 {
		t.Errorf("per-relay limit: %d %v", code, out)
	}
}

func TestRelaySlowsDownAfterManyDeadTokens(t *testing.T) {
	fp := &fakePusher{err: push.ErrTokenGone}
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 1, SendBurst: 1, RelayServe: true, RelayAPNs: fp, RelayRate: 1000, RelayBurst: 1000, RelayTokenPerMinute: 1000, RelayGoneLimit: 3})
	id, key := registerRelayKey(t, e)
	for i := 0; i < 4; i++ {
		m := map[string]any{"platform": "ios", "token": "dead" + string(rune('a'+i)), "kind": "message", "msg_id": 1, "bot_id": "Kx3abcde"}
		if code, _, _ := relayCall(t, e.srv.URL, "/v1/relay/push", key, m); code != 410 {
			t.Fatalf("push %d: %d", i, code)
		}
	}
	e.s.rs.mu.Lock()
	ent := e.s.rs.relays[id]
	degraded, burst := ent.degraded, ent.lim.Burst()
	e.s.rs.mu.Unlock()
	if !degraded || burst != 100 {
		t.Errorf("degraded = %v burst = %d, want true and 100", degraded, burst)
	}
}

func TestRelayClientRegistersAgainOnUnknownKeyButNotWhenBlocked(t *testing.T) {
	fp := &fakePusher{}
	relay := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 1, SendBurst: 1, RelayServe: true, RelayAPNs: fp})
	home := setupWith(t, Options{})
	c := push.NewRelay(relay.srv.URL, home.s.store, "t", nil)
	n := push.Notification{Platform: "ios", Token: "t", Kind: "message", MessageID: 1, BotID: "Kx3abcde"}
	if err := c.Push(context.Background(), n); err != nil {
		t.Fatal(err)
	}
	// The relay forgets everything (a fresh database): the key is unknown.
	if _, err := relay.s.store.RelayByKey(context.Background(), "x"); err == nil {
		t.Fatal("unexpected")
	}
	ctx := context.Background()
	if err := home.s.store.SetMeta(ctx, "relay_key", "stale"); err != nil {
		t.Fatal(err)
	}
	c = push.NewRelay(relay.srv.URL, home.s.store, "t", nil)
	if err := c.Push(ctx, n); err != nil {
		t.Fatalf("after stale key: %v", err)
	}
	if got := relay.s.m.relayReqs.Value("registered"); got != 2 {
		t.Errorf("registrations = %d, want 2", got)
	}
	// Block the relay now registered: no new registration.
	id, _ := home.s.store.GetMeta(ctx, "relay_id")
	relay.s.store.BlockRelay(ctx, id, true)
	err := c.Push(ctx, n)
	if err == nil {
		t.Fatal("blocked relay accepted")
	}
	if _, retry := push.Retryable(err); retry {
		t.Error("401 is retryable")
	}
	if got := relay.s.m.relayReqs.Value("registered"); got != 2 {
		t.Errorf("a blocked gateway registered again (%d)", got)
	}
}

func TestRelayClientMapsStatuses(t *testing.T) {
	status, retryAfter := 200, 0
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/gateways") {
			w.Write([]byte(`{"ok":true,"result":{"relay_id":"r1","relay_key":"k1"}}`))
			return
		}
		hits++
		w.WriteHeader(status)
		w.Write([]byte(`{"ok":false,"description":"x","parameters":{"retry_after":` + itoa(retryAfter) + `}}`))
	}))
	defer srv.Close()
	home := setupWith(t, Options{})
	c := push.NewRelay(srv.URL, home.s.store, "t", nil)
	n := push.Notification{Platform: "ios", Token: "t", Kind: "message", MessageID: 1, BotID: "Kx3abcde"}
	run := func(code, after int) error {
		status, retryAfter = code, after
		return c.Push(context.Background(), n)
	}
	if err := run(410, 0); err != push.ErrTokenGone {
		t.Errorf("410: %v", err)
	}
	if after, ok := push.Retryable(run(429, 7)); !ok || after != 7*time.Second {
		t.Errorf("429: %v %v", after, ok)
	}
	for _, code := range []int{500, 502, 504} {
		if _, ok := push.Retryable(run(code, 0)); !ok {
			t.Errorf("%d not retryable", code)
		}
	}
	for _, code := range []int{400, 403, 413, 422} {
		if err := run(code, 0); err == nil {
			t.Errorf("%d accepted", code)
		} else if _, ok := push.Retryable(err); ok {
			t.Errorf("%d retryable", code)
		}
	}
	// A dead connection is retryable.
	srv.Close()
	if _, ok := push.Retryable(c.Push(context.Background(), n)); !ok {
		t.Error("network error not retryable")
	}
}

func TestInfoReportsFeaturesAndPushModes(t *testing.T) {
	e := setupWith(t, Options{RelayServe: true, PushIOS: "direct", PushAndroid: "off"})
	info := must[struct {
		Features []string          `json:"features"`
		Push     map[string]string `json:"push"`
		API      int               `json:"api"`
	}](t, e.do("GET", "/v1/info", "", nil))
	if len(info.Features) != 2 || info.Features[0] != "link" || info.Features[1] != "relay" || info.Push["ios"] != "direct" || info.Push["android"] != "off" || info.API != 2 {
		t.Errorf("info = %+v", info)
	}
	plain := setup(t)
	info = must[struct {
		Features []string          `json:"features"`
		Push     map[string]string `json:"push"`
		API      int               `json:"api"`
	}](t, plain.do("GET", "/v1/info", "", nil))
	if len(info.Features) != 1 || info.Features[0] != "link" || info.Push["ios"] != "direct" {
		t.Errorf("plain info = %+v", info)
	}
}

func TestNothingIsQueuedForAPlatformWithNoRoute(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, PushIOS: "off"})
	_, token := e.register("ios")
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{"body": "x"}))
	if len(e.pusher.sent) != 0 {
		t.Error("pushed with route off")
	}
}
