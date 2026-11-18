package client

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type call struct {
	Path   string
	Params map[string]string
}

// fakeGateway records bot API calls and answers with Telegram's envelope.
type fakeGateway struct {
	mu    sync.Mutex
	calls []call
	fail  string // when set, every call fails with this description
	srv   *httptest.Server
}

func newGateway(t *testing.T) *fakeGateway {
	g := &fakeGateway{}
	g.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p map[string]string
		json.NewDecoder(r.Body).Decode(&p)
		g.mu.Lock()
		g.calls = append(g.calls, call{r.URL.Path, p})
		fail := g.fail
		g.mu.Unlock()
		if fail != "" {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 400, "description": fail})
			return
		}
		var res any = map[string]any{"message_id": 7}
		switch {
		case strings.HasSuffix(r.URL.Path, "/getMe"):
			res = map[string]any{"id": "Abc12345", "name": "Deploys"}
		case p["dry_run"] == "true":
			res = map[string]any{"dry_run": true, "raw_size": 120, "compressed_size": 90, "removed": []string{"onclick on <div>"}}
		case strings.HasSuffix(r.URL.Path, "/deleteMessage"), strings.HasSuffix(r.URL.Path, "/editMessageData"):
			res = true
		}
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": res})
	}))
	t.Cleanup(g.srv.Close)
	return g
}

func (g *fakeGateway) last(t *testing.T) call {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) == 0 {
		t.Fatal("no calls")
	}
	return g.calls[len(g.calls)-1]
}

func (g *fakeGateway) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.calls)
}

type run struct {
	out, errOut bytes.Buffer
	code        int
}

func exec(t *testing.T, g *fakeGateway, stdin string, piped bool, env map[string]string, args ...string) *run {
	t.Helper()
	r := &run{}
	if env == nil {
		env = map[string]string{}
	}
	if _, ok := env["HONK_URL"]; !ok && g != nil {
		env["HONK_URL"] = g.srv.URL
	}
	if _, ok := env["HONK_TOKEN"]; !ok {
		env["HONK_TOKEN"] = "Abc12345:secret"
	}
	env["HONK_CONFIG"] = filepath.Join(t.TempDir(), "none.json")
	r.code = Run(context.Background(), args, IO{
		Stdin: strings.NewReader(stdin), StdinPiped: piped, Stdout: &r.out, Stderr: &r.errOut,
		Getenv: func(k string) string { return env[k] },
	})
	return r
}

func TestSendFlagsAndPositional(t *testing.T) {
	g := newGateway(t)
	// Flags may come after the body.
	r := exec(t, g, "", false, nil, "send", "hello", "world", "--title", "T", "--level", "passive", "--group", "g", "--id", "i1", "--link", "https://x.example")
	if r.code != 0 || !strings.Contains(r.out.String(), "sent message 7") {
		t.Fatalf("code %d out %q err %q", r.code, r.out.String(), r.errOut.String())
	}
	c := g.last(t)
	if c.Path != "/botAbc12345:secret/sendMessage" {
		t.Errorf("path %s", c.Path)
	}
	want := map[string]string{"title": "T", "body": "hello world", "level": "passive", "group": "g", "id": "i1", "url": "https://x.example"}
	for k, v := range want {
		if c.Params[k] != v {
			t.Errorf("%s = %q, want %q", k, c.Params[k], v)
		}
	}
	if _, ok := c.Params["html"]; ok {
		t.Error("empty fields must not be sent")
	}
}

func TestSendStdin(t *testing.T) {
	g := newGateway(t)
	r := exec(t, g, "line one\nline two\n", true, nil, "send", "--title", "Log")
	if r.code != 0 {
		t.Fatal(r.errOut.String())
	}
	if b := g.last(t).Params["body"]; b != "line one\nline two" {
		t.Errorf("body %q", b)
	}
	// An argument wins over stdin; a terminal stdin is never read.
	exec(t, g, "ignored", true, nil, "send", "arg")
	if b := g.last(t).Params["body"]; b != "arg" {
		t.Errorf("body %q", b)
	}
	r = exec(t, g, "tty text", false, nil, "send")
	if r.code != 2 || !strings.Contains(r.errOut.String(), "nothing to send") {
		t.Errorf("empty send: %d %q", r.code, r.errOut.String())
	}
}

func TestSendFileArguments(t *testing.T) {
	g := newGateway(t)
	dir := t.TempDir()
	card := filepath.Join(dir, "card.html")
	data := filepath.Join(dir, "data.json")
	os.WriteFile(card, []byte(`<div>{{a}}</div>`), 0o600)
	os.WriteFile(data, []byte("{\n  \"a\": \"1\"\n}\n"), 0o600)
	r := exec(t, g, "", false, nil, "send", "body", "--html", "@"+card, "--data", "@"+data)
	if r.code != 0 {
		t.Fatal(r.errOut.String())
	}
	c := g.last(t)
	if c.Params["html"] != "<div>{{a}}</div>" || c.Params["data"] != `{"a":"1"}` {
		t.Errorf("params %v", c.Params)
	}
	r = exec(t, g, "", false, nil, "send", "body", "--html", "@"+filepath.Join(dir, "missing.html"))
	if r.code != 1 {
		t.Errorf("missing file: code %d", r.code)
	}
}

func TestFailureExitCodeAndDescription(t *testing.T) {
	g := newGateway(t)
	g.fail = "Bad Request: body is required"
	r := exec(t, g, "", false, nil, "send", "x")
	if r.code != 1 || !strings.Contains(r.errOut.String(), "Bad Request: body is required") {
		t.Errorf("code %d err %q", r.code, r.errOut.String())
	}
	if strings.Contains(r.errOut.String(), "secret") {
		t.Error("token leaked into the error")
	}
	// No server at all: the error must not contain the token either.
	r = exec(t, nil, "", false, map[string]string{"HONK_URL": "http://127.0.0.1:1"}, "send", "x")
	if r.code != 1 || strings.Contains(r.errOut.String(), "secret") {
		t.Errorf("connect failure: %d %q", r.code, r.errOut.String())
	}
	r = exec(t, g, "", false, map[string]string{"HONK_TOKEN": ""}, "me")
	if r.code != 1 || !strings.Contains(r.errOut.String(), "token") {
		t.Errorf("no token: %d %q", r.code, r.errOut.String())
	}
	if r := exec(t, g, "", false, nil, "bogus"); r.code != 2 {
		t.Errorf("unknown command: %d", r.code)
	}
	if r := exec(t, g, "", false, nil, "send", "--nope"); r.code != 2 {
		t.Errorf("bad flag: %d", r.code)
	}
}

func TestConfigFileAndPrecedence(t *testing.T) {
	g := newGateway(t)
	cfg := filepath.Join(t.TempDir(), "config.json")
	os.WriteFile(cfg, []byte(`{"url":"`+g.srv.URL+`","token":"File1234:filesecret"}`), 0o600)
	var out, errOut bytes.Buffer
	env := map[string]string{"HONK_CONFIG": cfg}
	code := Run(context.Background(), []string{"me"}, IO{Stdout: &out, Stderr: &errOut, Getenv: func(k string) string { return env[k] }})
	if code != 0 || g.last(t).Path != "/botFile1234:filesecret/getMe" || !strings.Contains(out.String(), `"name": "Deploys"`) {
		t.Fatalf("code %d path %s out %q err %q", code, g.last(t).Path, out.String(), errOut.String())
	}
	// The environment beats the file, flags beat the environment.
	env["HONK_TOKEN"] = "Env12345:envsecret"
	Run(context.Background(), []string{"me"}, IO{Stdout: &out, Stderr: &errOut, Getenv: func(k string) string { return env[k] }})
	if g.last(t).Path != "/botEnv12345:envsecret/getMe" {
		t.Errorf("env: %s", g.last(t).Path)
	}
	Run(context.Background(), []string{"me", "--token", "Flag1234:flagsecret"}, IO{Stdout: &out, Stderr: &errOut, Getenv: func(k string) string { return env[k] }})
	if g.last(t).Path != "/botFlag1234:flagsecret/getMe" {
		t.Errorf("flag: %s", g.last(t).Path)
	}
}

func TestEditAndDelete(t *testing.T) {
	g := newGateway(t)
	if r := exec(t, g, "", false, nil, "edit", "--id", "dep", "--data", `{"p": 50}`); r.code != 0 {
		t.Fatal(r.errOut.String())
	}
	c := g.last(t)
	if !strings.HasSuffix(c.Path, "/editMessageData") || c.Params["id"] != "dep" || c.Params["data"] != `{"p":50}` {
		t.Errorf("edit %+v", c)
	}
	if r := exec(t, g, "", false, nil, "delete", "--message-id", "9"); r.code != 0 {
		t.Fatal(r.errOut.String())
	}
	c = g.last(t)
	if !strings.HasSuffix(c.Path, "/deleteMessage") || c.Params["message_id"] != "9" {
		t.Errorf("delete %+v", c)
	}
	if r := exec(t, g, "", false, nil, "delete"); r.code != 2 {
		t.Errorf("delete without target: %d", r.code)
	}
}

func TestDryRunPrintsReport(t *testing.T) {
	g := newGateway(t)
	r := exec(t, g, "", false, nil, "send", "x", "--html", "<p>a</p>", "--dry-run")
	if r.code != 0 || g.last(t).Params["dry_run"] != "true" || !strings.Contains(r.out.String(), "120 bytes") || !strings.Contains(r.out.String(), "onclick on <div>") {
		t.Errorf("out %q err %q", r.out.String(), r.errOut.String())
	}
}

func TestEncryptRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	plain := []byte(`{"title":"T","body":"B"}`)
	text, err := Encrypt(key, "Abc12345", plain)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(text)
	if err != nil || len(raw) != 12+len(plain)+16 {
		t.Fatalf("layout: len %d err %v", len(raw), err)
	}
	got, err := Decrypt(key, "Abc12345", text)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("round trip: %q %v", got, err)
	}
	if _, err := Decrypt(key, "Other123", text); err == nil {
		t.Error("wrong AAD decrypted")
	}
	other := make([]byte, 32)
	if _, err := Decrypt(other, "Abc12345", text); err == nil {
		t.Error("wrong key decrypted")
	}
	tampered := []byte(text)
	tampered[20] ^= 1
	if _, err := Decrypt(key, "Abc12345", string(tampered)); err == nil {
		t.Error("tampered ciphertext decrypted")
	}
	if _, err := Encrypt(key[:16], "a", plain); err == nil {
		t.Error("short key accepted")
	}
	// Fresh nonce each time.
	again, _ := Encrypt(key, "Abc12345", plain)
	if again == text {
		t.Error("nonce reused")
	}
}

func TestParseKey(t *testing.T) {
	key := bytes.Repeat([]byte{0xfb, 0xff}, 16) // encodes with + and / in the std alphabet
	for _, enc := range []string{base64.StdEncoding.EncodeToString(key), base64.RawStdEncoding.EncodeToString(key), base64.URLEncoding.EncodeToString(key), base64.RawURLEncoding.EncodeToString(key)} {
		got, err := ParseKey(enc)
		if err != nil || !bytes.Equal(got, key) {
			t.Errorf("ParseKey(%q) = %x, %v", enc, got, err)
		}
	}
	if _, err := ParseKey("AAAA"); err == nil {
		t.Error("short key accepted")
	}
	if BotID("Abc12345:secret") != "Abc12345" || BotID("12:s") != "12" {
		t.Error("BotID")
	}
}

func TestSendWithKeySendsCiphertext(t *testing.T) {
	g := newGateway(t)
	key := make([]byte, 32)
	rand.Read(key)
	k := base64.URLEncoding.EncodeToString(key)
	r := exec(t, g, "", false, nil, "send", "secret body", "--title", "T", "--level", "passive", "--id", "i", "--key", k)
	if r.code != 0 {
		t.Fatal(r.errOut.String())
	}
	p := g.last(t).Params
	if p["body"] != "" || p["title"] != "" || p["level"] != "passive" || p["id"] != "i" || p["ciphertext"] == "" {
		t.Fatalf("params %v", p)
	}
	plain, err := Decrypt(key, "Abc12345", p["ciphertext"])
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]string
	json.Unmarshal(plain, &m)
	if m["body"] != "secret body" || m["title"] != "T" {
		t.Errorf("plaintext %v", m)
	}
	// edit encrypts {"data": ...}.
	exec(t, g, "", false, nil, "edit", "--id", "i", "--data", `{"a":1}`, "--key", k)
	p = g.last(t).Params
	plain, err = Decrypt(key, "Abc12345", p["ciphertext"])
	if err != nil || p["data"] != "" || string(plain) != `{"data":"{\"a\":1}"}` {
		t.Errorf("edit: %v %q %v", p, plain, err)
	}
	if r := exec(t, g, "", false, nil, "send", "x", "--key", "bad"); r.code != 1 {
		t.Errorf("bad key: %d", r.code)
	}
}

func TestPreviewWatch(t *testing.T) {
	g := newGateway(t)
	dir := t.TempDir()
	card := filepath.Join(dir, "card.html")
	data := filepath.Join(dir, "data.json")
	os.WriteFile(card, []byte(`<p>v1</p>`), 0o600)
	os.WriteFile(data, []byte(`{"a":1}`), 0o600)

	// Without --watch: one dry run, one send, fixed id, passive.
	r := exec(t, g, "", false, nil, "preview", card, "--data", data)
	if r.code != 0 || g.count() != 2 {
		t.Fatalf("code %d calls %d err %q", r.code, g.count(), r.errOut.String())
	}
	p := g.last(t).Params
	if p["id"] != "honk-preview" || p["level"] != "passive" || p["html"] != "<p>v1</p>" || p["data"] != `{"a":1}` || p["dry_run"] != "" {
		t.Errorf("params %v", p)
	}

	// With --watch: a save triggers another send with the same id.
	before := g.count()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	var out, errOut safeBuf
	go func() {
		done <- Run(ctx, []string{"preview", card, "--data", data, "--watch", "--id", "fixed"}, IO{
			Stdout: &out, Stderr: &errOut, Poll: 10 * time.Millisecond,
			Getenv: func(k string) string {
				return map[string]string{"HONK_URL": g.srv.URL, "HONK_TOKEN": "Abc12345:secret", "HONK_CONFIG": filepath.Join(dir, "x")}[k]
			},
		})
	}()
	waitFor(t, func() bool { return g.count() >= before+2 })
	os.WriteFile(card, []byte(`<p>version two</p>`), 0o600)
	waitFor(t, func() bool { return g.count() >= before+4 })
	cancel()
	if code := <-done; code != 0 {
		t.Errorf("exit %d: %s", code, errOut.String())
	}
	p = g.last(t).Params
	if p["html"] != "<p>version two</p>" || p["id"] != "fixed" {
		t.Errorf("after save: %v", p)
	}
	if !strings.Contains(out.String(), "watching") {
		t.Errorf("out %q", out.String())
	}
}

type safeBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *safeBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *safeBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

var _ io.Writer = (*safeBuf)(nil)

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 400; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}

// app/src/e2e.vector.json is also checked by HonkKit (Swift) and :core
// (Kotlin): a message sealed by any of the three opens in the others.
func TestSharedVector(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "app", "src", "e2e.vector.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct{ Key, AAD, Plaintext, Ciphertext string }
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	key, err := ParseKey(v.Key)
	if err != nil {
		t.Fatal(err)
	}
	pt, err := Decrypt(key, v.AAD, v.Ciphertext)
	if err != nil || string(pt) != v.Plaintext {
		t.Fatalf("vector = %q, %v", pt, err)
	}
	if _, err := Decrypt(key, "other", v.Ciphertext); err == nil {
		t.Error("a different AAD must fail")
	}
	// The wrapped bot key of the multi-device design.
	var vw struct {
		KeyWrap map[string]string `json:"key_wrap"`
	}
	if err := json.Unmarshal(b, &vw); err != nil {
		t.Fatal(err)
	}
	kw := vw.KeyWrap
	gk, _ := ParseKey(kw["group_key"])
	bk, _ := ParseKey(kw["bot_key"])
	got, err := UnwrapBotKey(gk, kw["wrapped"], kw["bot_id"])
	if err != nil || !bytes.Equal(got, bk) {
		t.Fatalf("unwrap = %x, %v", got, err)
	}
	if _, err := UnwrapBotKey(gk, kw["wrapped"], "other"); err == nil {
		t.Error("another bot id must not unwrap")
	}
	if len(kw["wrapped"]) != 80 {
		t.Errorf("wrapped is %d characters", len(kw["wrapped"]))
	}
	// nonce (12) + content + tag (16): the format, byte for byte.
	if raw, err := base64.RawURLEncoding.DecodeString(v.Ciphertext); err != nil || len(raw) != 12+len(v.Plaintext)+16 {
		t.Errorf("ciphertext shape: %d bytes, %v", len(raw), err)
	}
}
