package honk

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "Ab3dEf9h:secret"

// vector is app/src/e2e.vector.json, the test vector every Honk client checks.
type vector struct {
	Key        string `json:"key"`
	AAD        string `json:"aad"`
	Plaintext  string `json:"plaintext"`
	Ciphertext string `json:"ciphertext"`
}

func loadVector(t *testing.T) vector {
	t.Helper()
	b, err := os.ReadFile("../../app/src/e2e.vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vector
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestVector(t *testing.T) {
	v := loadVector(t)
	key, err := ParseKey(v.Key)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Open(key, v.AAD, v.Ciphertext)
	if err != nil || string(got) != v.Plaintext {
		t.Fatalf("Open = %q, %v", got, err)
	}
	sealed, err := Seal(key, v.AAD, []byte(v.Plaintext))
	if err != nil {
		t.Fatal(err)
	}
	if again, err := Open(key, v.AAD, sealed); err != nil || string(again) != v.Plaintext {
		t.Fatalf("round trip = %q, %v", again, err)
	}
	if _, err := Open(key, "other", sealed); err == nil {
		t.Fatal("opened with the wrong AAD")
	}
}

func TestParseKey(t *testing.T) {
	std := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
	for _, s := range []string{std, strings.TrimRight(std, "="), " " + std + "\n"} {
		if k, err := ParseKey(s); err != nil || len(k) != 32 || k[31] != 0x1f {
			t.Errorf("ParseKey(%q) = %v, %v", s, k, err)
		}
	}
	for _, s := range []string{"", "AAEC", "not base64!"} {
		if _, err := ParseKey(s); err == nil {
			t.Errorf("ParseKey(%q) succeeded", s)
		}
	}
}

// fakeGateway answers /bot<token>/<method> with fn and records the calls.
type fakeGateway struct {
	mu    sync.Mutex
	calls []call
	fn    func(method string, p map[string]any) (int, any)
}

type call struct {
	method string
	params map[string]any
}

func (g *fakeGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method, ok := strings.CutPrefix(r.URL.Path, "/bot"+testToken+"/")
	if !ok || r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"ok":false,"error_code":404,"description":"Not Found"}`)
		return
	}
	var p map[string]any
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	g.mu.Lock()
	g.calls = append(g.calls, call{method, p})
	g.mu.Unlock()
	status, result := g.fn(method, p)
	w.WriteHeader(status)
	if status != http.StatusOK {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": status, "description": result})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": result})
}

func (g *fakeGateway) last() call {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.calls[len(g.calls)-1]
}

func newFake(t *testing.T, fn func(method string, p map[string]any) (int, any)) (*fakeGateway, *Client) {
	g := &fakeGateway{fn: fn}
	srv := httptest.NewServer(g)
	t.Cleanup(srv.Close)
	return g, &Client{URL: srv.URL + "/", Token: testToken}
}

func TestSendPlain(t *testing.T) {
	g, c := newFake(t, func(string, map[string]any) (int, any) {
		return 200, map[string]any{"message_id": 7, "bot_id": "Ab3dEf9h", "kind": "message", "id": "deploy", "date": 1700000000000}
	})
	sent, err := c.Send(context.Background(), Message{
		Title: "Deploy", Body: "live <b>", HTML: "<b>{{status}}</b>", Data: map[string]string{"status": "ok"},
		Level: TimeSensitive, ID: "deploy", TTL: 2 * time.Minute, Silent: true, AllowQueries: true, ParseMode: Markdown,
	})
	if err != nil {
		t.Fatal(err)
	}
	if sent.MessageID != 7 || sent.ID != "deploy" || sent.Date != 1700000000000 {
		t.Fatalf("sent = %+v", sent)
	}
	got := g.last()
	want := map[string]any{
		"title": "Deploy", "body": "live <b>", "html": "<b>{{status}}</b>", "data": `{"status":"ok"}`,
		"level": "timeSensitive", "id": "deploy", "ttl": float64(120), "silent": true, "allow_queries": true, "parse_mode": "Markdown",
	}
	if got.method != "sendMessage" || !equal(got.params, want) {
		t.Fatalf("call = %s %v", got.method, got.params)
	}
}

func TestSendEncrypted(t *testing.T) {
	v := loadVector(t)
	key, _ := ParseKey(v.Key)
	g, c := newFake(t, func(string, map[string]any) (int, any) { return 200, map[string]any{"message_id": 1} })
	c.Key = key
	_, err := c.Send(context.Background(), Message{
		Title: "t", Body: "b", Data: `{"n":1}`, Image: "https://example.com/i.png",
		Level: Passive, Group: "g", ID: "x", Open: OpenURL, URL: "https://example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	p := g.last().params
	for _, k := range []string{"title", "body", "html", "data", "url", "copy", "icon", "image"} {
		if _, ok := p[k]; ok {
			t.Errorf("%s sent next to the ciphertext", k)
		}
	}
	if p["level"] != "passive" || p["group"] != "g" || p["id"] != "x" || p["open"] != "url" {
		t.Errorf("plain fields = %v", p)
	}
	plain, err := Open(key, "Ab3dEf9h", p["ciphertext"].(string))
	if err != nil {
		t.Fatal(err)
	}
	var content map[string]string
	_ = json.Unmarshal(plain, &content)
	want := map[string]string{"title": "t", "body": "b", "data": `{"n":1}`, "url": "https://example.com", "image": "https://example.com/i.png"}
	if !equal(content, want) {
		t.Fatalf("content = %v", content)
	}

	if err := c.Edit(context.Background(), ByID("x"), map[string]int{"n": 2}); err != nil {
		t.Fatal(err)
	}
	p = g.last().params
	if p["id"] != "x" || p["data"] != nil {
		t.Fatalf("edit = %v", p)
	}
	plain, _ = Open(key, "Ab3dEf9h", p["ciphertext"].(string))
	if string(plain) != `{"data":"{\"n\":2}"}` {
		t.Fatalf("edit content = %s", plain)
	}
}

func TestEditDeleteMe(t *testing.T) {
	g, c := newFake(t, func(method string, _ map[string]any) (int, any) {
		if method == "getMe" {
			return 200, map[string]any{"id": "Ab3dEf9h", "name": "CI", "default_level": "active", "encrypted": true}
		}
		return 200, true
	})
	ctx := context.Background()
	if err := c.Edit(ctx, ByMessageID(9), json.RawMessage(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	if got := g.last(); got.method != "editMessageData" || !equal(got.params, map[string]any{"message_id": float64(9), "data": `{"a":1}`}) {
		t.Fatalf("edit = %v", got)
	}
	if err := c.Delete(ctx, ByID("deploy")); err != nil {
		t.Fatal(err)
	}
	if got := g.last(); got.method != "deleteMessage" || !equal(got.params, map[string]any{"id": "deploy"}) {
		t.Fatalf("delete = %v", got)
	}
	if err := c.Delete(ctx, Target{}); err == nil {
		t.Fatal("empty target accepted")
	}
	bot, err := c.Me(ctx)
	if err != nil || bot.ID != "Ab3dEf9h" || !bot.Encrypted || bot.DefaultLevel != Active {
		t.Fatalf("me = %+v, %v", bot, err)
	}
}

func TestErrors(t *testing.T) {
	var n atomic.Int32
	_, c := newFake(t, func(string, map[string]any) (int, any) {
		if n.Add(1) < 3 {
			return 429, "Too Many Requests"
		}
		return 400, "Bad Request: body is required"
	})
	_, err := c.Send(context.Background(), Message{})
	var e *Error
	if !errors.As(err, &e) || e.Code != 429 || n.Load() != 1 {
		t.Fatalf("err = %v after %d calls", err, n.Load())
	}
	c.Retries = 2
	start := time.Now()
	_, err = c.Send(context.Background(), Message{})
	if !IsCode(err, 400) || !strings.Contains(err.Error(), "body is required") || n.Load() != 3 {
		t.Fatalf("err = %v after %d calls", err, n.Load())
	}
	if d := time.Since(start); d < time.Second {
		t.Fatalf("retried after %v", d)
	}

	// A transport error does not carry the URL, which holds the token.
	c = &Client{URL: "http://127.0.0.1:1", Token: testToken}
	_, err = c.Me(context.Background())
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("err = %v", err)
	}
}

func TestPoll(t *testing.T) {
	var polls atomic.Int32
	answered := make(chan map[string]any, 2)
	_, c := newFake(t, func(method string, p map[string]any) (int, any) {
		switch method {
		case "getUpdates":
			switch polls.Add(1) {
			case 1:
				if p["offset"] != nil || p["timeout"] != float64(1) { // 1.5 s is cut to whole seconds
					t.Errorf("first poll = %v", p)
				}
				return 200, []any{
					map[string]any{"update_id": 4, "widget_query": map[string]any{"id": "q1", "message_id": 7, "data": "ping"}},
					map[string]any{"update_id": 5, "something_else": true},
					map[string]any{"update_id": 6, "widget_query": map[string]any{"id": "q2", "message_id": 7, "data": "fail"}},
				}
			case 2:
				if p["offset"] != float64(7) {
					t.Errorf("second poll offset = %v", p["offset"])
				}
				return 500, "Internal Server Error"
			default:
				return 409, "Conflict: can't use getUpdates method while webhook is active"
			}
		case "answerWidgetQuery":
			answered <- p
			return 200, true
		}
		return 404, "Not Found"
	})
	var errs []error
	var mu sync.Mutex
	err := c.Poll(context.Background(), func(_ context.Context, q WidgetQuery) (string, error) {
		if q.Data == "fail" {
			return "", errors.New("nope")
		}
		return "pong:" + q.Data, nil
	}, &PollOptions{Timeout: 1500 * time.Millisecond, OnError: func(err error) { mu.Lock(); errs = append(errs, err); mu.Unlock() }})
	if !IsCode(err, 409) {
		t.Fatalf("Poll = %v", err)
	}
	close(answered)
	var got []map[string]any
	for p := range answered {
		got = append(got, p)
	}
	if len(got) != 1 || !equal(got[0], map[string]any{"widget_query_id": "q1", "data": "pong:ping"}) {
		t.Fatalf("answers = %v", got)
	}
	if len(errs) != 2 { // the handler's error and the failed poll
		t.Fatalf("errors = %v", errs)
	}
}

func TestPollStops(t *testing.T) {
	_, c := newFake(t, func(string, map[string]any) (int, any) {
		time.Sleep(50 * time.Millisecond)
		return 200, []any{}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	if err := c.Poll(ctx, nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Poll = %v", err)
	}
}

func TestWebhookHandler(t *testing.T) {
	g, c := newFake(t, func(string, map[string]any) (int, any) { return 200, true })
	var failures atomic.Int32
	h := c.WebhookHandler(func(_ context.Context, q WidgetQuery) (string, error) {
		if q.Data == "fail" {
			return "", errors.New("nope")
		}
		return `{"ok":1}`, nil
	}, &WebhookOptions{Secret: "s3cret", OnError: func(error) { failures.Add(1) }})
	post := func(secret, body string) int {
		r := httptest.NewRequest(http.MethodPost, "/hook", strings.NewReader(body))
		if secret != "" {
			r.Header.Set(SecretHeader, secret)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	query := `{"update_id":1,"widget_query":{"id":"q1","message_id":3,"data":"x"}}`
	if code := post("", query); code != 401 {
		t.Errorf("no secret: %d", code)
	}
	if code := post("wrong", query); code != 401 {
		t.Errorf("wrong secret: %d", code)
	}
	if code := post("s3cret", "{"); code != 400 {
		t.Errorf("bad body: %d", code)
	}
	if code := post("s3cret", query); code != 200 {
		t.Errorf("query: %d", code)
	}
	if got := g.last(); got.method != "answerWidgetQuery" || !equal(got.params, map[string]any{"widget_query_id": "q1", "data": `{"ok":1}`}) {
		t.Fatalf("answer = %v", got)
	}
	if code := post("s3cret", `{"update_id":2,"widget_query":{"id":"q2","message_id":3,"data":"fail"}}`); code != 500 {
		t.Errorf("failing handler: %d", code)
	}
	if failures.Load() != 1 {
		t.Errorf("OnError heard %d failures", failures.Load())
	}
	if code := post("s3cret", `{"update_id":3}`); code != 200 {
		t.Errorf("other update: %d", code)
	}
	r := httptest.NewRequest(http.MethodGet, "/hook", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 405 {
		t.Errorf("GET: %d", w.Code)
	}
}

func equal(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}
