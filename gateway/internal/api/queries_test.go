package api

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/evumi/honk/gateway/internal/store"
)

type update struct {
	UpdateID    int64 `json:"update_id"`
	WidgetQuery struct {
		ID        string `json:"id"`
		MessageID int64  `json:"message_id"`
		Data      string `json:"data"`
	} `json:"widget_query"`
}

func queryEnv(t *testing.T, timeout time.Duration) *env {
	return setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 50, QueryTimeout: timeout})
}

// card sends a message and returns its id.
func (e *env) card(token string, allow bool) int64 {
	m := must[store.Message](e.t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{
		"body": "hi", "html": "<div>x</div>", "allow_queries": allow,
	}))
	if m.AllowQueries != allow {
		e.t.Fatalf("allow_queries = %v, want %v", m.AllowQueries, allow)
	}
	return m.ID
}

// query starts POST /v1/queries in the background.
func (e *env) query(secret string, msg int64, data string) <-chan envelope {
	ch := make(chan envelope, 1)
	go func() {
		b, _ := json.Marshal(map[string]any{"message_id": msg, "data": data})
		req, _ := http.NewRequest("POST", e.srv.URL+"/v1/queries", strings.NewReader(string(b)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+secret)
		res, err := http.DefaultClient.Do(req)
		var out envelope
		if err == nil {
			json.NewDecoder(res.Body).Decode(&out)
			res.Body.Close()
			if !out.OK {
				out.ErrorCode = res.StatusCode
			}
		}
		ch <- out
	}()
	return ch
}

func (e *env) updates(token string, params string) []update {
	return must[[]update](e.t, e.do("GET", "/bot"+token+"/getUpdates"+params, "", nil))
}

func wait(t *testing.T, ch <-chan envelope) envelope {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatal("query never returned")
		return envelope{}
	}
}

func TestQueryViaGetUpdates(t *testing.T) {
	e := queryEnv(t, 5*time.Second)
	secret, token := e.register("ios")
	msg := e.card(token, true)

	got := make(chan []update, 1)
	go func() { got <- e.updates(token, "?timeout=10") }() // long poll, started first
	time.Sleep(100 * time.Millisecond)
	res := e.query(secret, msg, "plus")

	var ups []update
	select {
	case ups = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("long poll did not wake")
	}
	if len(ups) != 1 || ups[0].WidgetQuery.Data != "plus" || ups[0].WidgetQuery.MessageID != msg || ups[0].WidgetQuery.ID == "" {
		t.Fatalf("updates = %+v", ups)
	}
	qid := ups[0].WidgetQuery.ID
	// Not confirmed yet: it is delivered again; offset past it confirms.
	if again := e.updates(token, ""); len(again) != 1 {
		t.Errorf("unconfirmed update gone: %+v", again)
	}
	must[bool](t, e.do("POST", "/bot"+token+"/answerWidgetQuery", "", map[string]any{"widget_query_id": qid, "data": "7"}))
	out := wait(t, res)
	if !out.OK || string(out.Result) != `{"data":"7"}` {
		t.Fatalf("answer = %+v", out)
	}
	if left := e.updates(token, fmt.Sprintf("?offset=%d", ups[0].UpdateID+1)); len(left) != 0 {
		t.Errorf("confirmed update came back: %+v", left)
	}
	// Answering twice: the query is gone.
	if r := e.do("POST", "/bot"+token+"/answerWidgetQuery", "", map[string]any{"widget_query_id": qid}); r.OK || r.ErrorCode != 400 {
		t.Errorf("second answer = %+v", r)
	}
}

func TestGetUpdatesLongPollTimesOutEmpty(t *testing.T) {
	e := queryEnv(t, time.Second)
	_, token := e.register("ios")
	start := time.Now()
	if ups := e.updates(token, "?timeout=1"); len(ups) != 0 || time.Since(start) < 900*time.Millisecond {
		t.Errorf("ups = %+v after %v", ups, time.Since(start))
	}
	if r := e.do("GET", "/bot"+token+"/getUpdates?timeout=51", "", nil); r.OK || r.ErrorCode != 400 {
		t.Errorf("timeout 51 = %+v", r)
	}
}

func TestQueryUpdatesExpire(t *testing.T) {
	e := queryEnv(t, 200*time.Millisecond)
	secret, token := e.register("ios")
	out := wait(t, e.query(secret, e.card(token, true), "x"))
	if out.OK || out.ErrorCode != 504 {
		t.Fatalf("unanswered query = %+v", out)
	}
	time.Sleep(100 * time.Millisecond) // the update outlives the wait by nothing: gone
	if ups := e.updates(token, ""); len(ups) != 0 {
		t.Errorf("expired update still queued: %+v", ups)
	}
}

func TestAnswerAfterTimeout(t *testing.T) {
	e := queryEnv(t, 150*time.Millisecond)
	secret, token := e.register("ios")
	res := e.query(secret, e.card(token, true), "x")
	var ups []update
	for len(ups) == 0 {
		ups = e.updates(token, "")
	}
	if out := wait(t, res); out.ErrorCode != 504 {
		t.Fatalf("query = %+v", out)
	}
	r := e.do("POST", "/bot"+token+"/answerWidgetQuery", "", map[string]any{"widget_query_id": ups[0].WidgetQuery.ID, "data": "late"})
	if r.OK || r.ErrorCode != 400 {
		t.Errorf("late answer = %+v", r)
	}
}

func TestAnswerAnotherBotsQuery(t *testing.T) {
	e := queryEnv(t, 5*time.Second)
	secret, token := e.register("ios")
	_, other := e.register("android")
	res := e.query(secret, e.card(token, true), "x")
	var ups []update
	for len(ups) == 0 {
		ups = e.updates(token, "")
	}
	qid := ups[0].WidgetQuery.ID
	if r := e.do("POST", "/bot"+other+"/answerWidgetQuery", "", map[string]any{"widget_query_id": qid, "data": "stolen"}); r.OK || r.ErrorCode != 400 {
		t.Fatalf("other bot's answer = %+v", r)
	}
	if o := e.updates(other, ""); len(o) != 0 {
		t.Errorf("other bot saw the update: %+v", o)
	}
	must[bool](t, e.do("POST", "/bot"+token+"/answerWidgetQuery", "", map[string]any{"widget_query_id": qid, "data": "mine"}))
	if out := wait(t, res); !out.OK || string(out.Result) != `{"data":"mine"}` {
		t.Errorf("answer = %+v", out)
	}
}

func TestQueryChecks(t *testing.T) {
	e := queryEnv(t, 200*time.Millisecond)
	secret, token := e.register("ios")
	other, _ := e.register("android")
	closed := e.card(token, false)
	open := e.card(token, true)

	for name, c := range map[string]struct {
		secret string
		msg    int64
		data   string
		code   int
	}{
		"not allowed":    {secret, closed, "x", 403},
		"other device":   {other, open, "x", 404},
		"unknown":        {secret, 9999, "x", 404},
		"empty data":     {secret, open, "", 400},
		"data too long":  {secret, open, strings.Repeat("a", 65), 400},
		"no credentials": {"", open, "x", 401},
	} {
		if out := wait(t, e.query(c.secret, c.msg, c.data)); out.OK || out.ErrorCode != c.code {
			t.Errorf("%s: %+v, want %d", name, out, c.code)
		}
	}
	// A 64-byte query is fine (it then waits for an answer and times out).
	if out := wait(t, e.query(secret, open, strings.Repeat("é", 32))); out.ErrorCode != 504 {
		t.Errorf("64 bytes: %+v", out)
	}
	// Answers are capped at 1 KB.
	r := e.do("POST", "/bot"+token+"/answerWidgetQuery", "", map[string]any{"widget_query_id": "x", "data": strings.Repeat("a", 1025)})
	if r.OK || r.ErrorCode != 400 || !strings.Contains(r.Description, "1024") {
		t.Errorf("long answer = %+v", r)
	}
}

func TestQueryRateLimit(t *testing.T) {
	e := queryEnv(t, 30*time.Millisecond)
	secret, token := e.register("ios")
	msg := e.card(token, true)
	for i := 0; i < 5; i++ {
		if out := wait(t, e.query(secret, msg, "x")); out.ErrorCode != 504 {
			t.Fatalf("query %d = %+v", i, out)
		}
	}
	if out := wait(t, e.query(secret, msg, "x")); out.ErrorCode != 429 {
		t.Errorf("6th query = %+v, want 429", out)
	}
	// Another device (and bot) has its own bucket.
	s2, t2 := e.register("android")
	if out := wait(t, e.query(s2, e.card(t2, true), "x")); out.ErrorCode != 504 {
		t.Errorf("other device = %+v", out)
	}
}

// webhookEnv is an env whose webhook client trusts the test TLS server on
// 127.0.0.1.
func webhookEnv(t *testing.T, h http.Handler) (*env, string) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 50, QueryTimeout: 3 * time.Second, WebhookAllowPrivate: true})
	hook := httptest.NewTLSServer(h)
	t.Cleanup(hook.Close)
	e.s.whClient = newWebhookClient(true, &tls.Config{InsecureSkipVerify: true})
	return e, hook.URL
}

func TestQueryViaWebhook(t *testing.T) {
	var mu sync.Mutex
	var gotSecret, gotType string
	var up update
	e, url := webhookEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		gotSecret, gotType = r.Header.Get("X-Honk-Bot-Api-Secret-Token"), r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &up)
	}))
	secret, token := e.register("ios")
	must[bool](t, e.do("POST", "/bot"+token+"/setWebhook", "", map[string]any{"url": url + "/hook", "secret_token": "s3cret-_1"}))
	info := must[map[string]any](t, e.do("GET", "/bot"+token+"/getWebhookInfo", "", nil))
	if info["url"] != url+"/hook" || info["pending_update_count"] != float64(0) {
		t.Errorf("info = %+v", info)
	}
	msg := e.card(token, true)
	res := e.query(secret, msg, "go")
	for i := 0; ; i++ {
		mu.Lock()
		id := up.WidgetQuery.ID
		mu.Unlock()
		if id != "" {
			must[bool](t, e.do("POST", "/bot"+token+"/answerWidgetQuery", "", map[string]any{"widget_query_id": id, "data": "ok"}))
			break
		}
		if i > 200 {
			t.Fatal("webhook never called")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if out := wait(t, res); !out.OK || string(out.Result) != `{"data":"ok"}` {
		t.Fatalf("answer = %+v", out)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotSecret != "s3cret-_1" || gotType != "application/json" || up.UpdateID == 0 || up.WidgetQuery.Data != "go" || up.WidgetQuery.MessageID != msg {
		t.Errorf("secret %q type %q update %+v", gotSecret, gotType, up)
	}

	// getUpdates conflicts with a webhook, like Telegram; deleteWebhook lifts it.
	if r := e.do("GET", "/bot"+token+"/getUpdates", "", nil); r.OK || r.ErrorCode != 409 {
		t.Errorf("getUpdates with webhook = %+v", r)
	}
	must[bool](t, e.do("POST", "/bot"+token+"/deleteWebhook", "", nil))
	if ups := e.updates(token, ""); len(ups) != 0 {
		t.Errorf("ups = %+v", ups)
	}
}

func TestWebhookFailureEndsQueryEarly(t *testing.T) {
	e, url := webhookEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	secret, token := e.register("ios")
	must[bool](t, e.do("POST", "/bot"+token+"/setWebhook", "", map[string]any{"url": url}))
	start := time.Now()
	if out := wait(t, e.query(secret, e.card(token, true), "x")); out.ErrorCode != 502 || time.Since(start) > time.Second {
		t.Errorf("query = %+v after %v", out, time.Since(start))
	}
}

func TestWebhookNoRedirects(t *testing.T) {
	var hits int
	var mu sync.Mutex
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { mu.Lock(); hits++; mu.Unlock() }))
	defer target.Close()
	e, url := webhookEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	secret, token := e.register("ios")
	must[bool](t, e.do("POST", "/bot"+token+"/setWebhook", "", map[string]any{"url": url}))
	if out := wait(t, e.query(secret, e.card(token, true), "x")); out.ErrorCode != 502 {
		t.Errorf("query = %+v", out)
	}
	mu.Lock()
	defer mu.Unlock()
	if hits != 0 {
		t.Error("redirect was followed")
	}
}

func TestSetWebhookRejectsUnsafeURLs(t *testing.T) {
	e := queryEnv(t, time.Second)
	_, token := e.register("ios")
	for _, u := range []string{
		"http://93.184.216.34/hook", // not https
		"https://127.0.0.1/hook",
		"https://127.1.2.3:8443/hook",
		"https://[::1]/hook",
		"https://10.0.0.5/hook",
		"https://192.168.1.1/hook",
		"https://172.16.0.1/hook",
		"https://169.254.169.254/latest/meta-data",
		"https://[fe80::1]/hook",
		"https://[fd00::1]/hook",
		"https://[::ffff:127.0.0.1]/hook",
		"https://100.64.0.1/hook",
		"https://0.0.0.0/hook",
		"https://localhost/hook",
		"https://user:pw@93.184.216.34/hook",
		"ftp://93.184.216.34/hook",
		"https:///hook",
		"not a url",
	} {
		r := e.do("POST", "/bot"+token+"/setWebhook", "", map[string]any{"url": u})
		if r.OK || r.ErrorCode != 400 {
			t.Errorf("setWebhook(%q) = %+v", u, r)
		}
	}
	if r := e.do("POST", "/bot"+token+"/setWebhook", "", map[string]any{"url": "https://93.184.216.34/hook", "secret_token": "bad token!"}); r.OK {
		t.Error("bad secret_token accepted")
	}
	// A public address is fine; an empty url removes it again.
	must[bool](t, e.do("POST", "/bot"+token+"/setWebhook", "", map[string]any{"url": "https://93.184.216.34/hook"}))
	must[bool](t, e.do("POST", "/bot"+token+"/setWebhook", "", map[string]any{"url": ""}))
	if info := must[map[string]any](t, e.do("GET", "/bot"+token+"/getWebhookInfo", "", nil)); info["url"] != "" {
		t.Errorf("info = %+v", info)
	}
}

func TestWebhookAllowPrivate(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, WebhookAllowPrivate: true})
	_, token := e.register("ios")
	must[bool](t, e.do("POST", "/bot"+token+"/setWebhook", "", map[string]any{"url": "https://10.0.0.5/hook"}))
	if r := e.do("POST", "/bot"+token+"/setWebhook", "", map[string]any{"url": "http://10.0.0.5/hook"}); r.OK {
		t.Error("http accepted")
	}
}

// The delivery client refuses to connect to a private address even when the
// stored URL passed the check (a hostname whose DNS answer changed).
func TestWebhookClientRefusesPrivateDial(t *testing.T) {
	hook := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer hook.Close()
	c := newWebhookClient(false, &tls.Config{InsecureSkipVerify: true})
	if _, err := c.Get(hook.URL); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Errorf("dial to loopback: %v", err)
	}
	if _, err := newWebhookClient(true, &tls.Config{InsecureSkipVerify: true}).Get(hook.URL); err != nil {
		t.Errorf("allowed dial: %v", err)
	}
}

func TestPublicIP(t *testing.T) {
	for ip, want := range map[string]bool{
		"93.184.216.34": true, "8.8.8.8": true, "2606:4700::1111": true,
		"127.0.0.1": false, "10.1.2.3": false, "172.31.0.1": false, "192.168.0.1": false, "169.254.1.1": false,
		"::1": false, "fe80::1": false, "fc00::1": false, "::": false, "224.0.0.1": false, "::ffff:10.0.0.1": false,
	} {
		if got := publicIP(netip.MustParseAddr(ip)); got != want {
			t.Errorf("publicIP(%s) = %v", ip, got)
		}
	}
}

// Any device of the group may query; the answer goes back to the one that asked.
func TestQueryFromAnotherDeviceOfTheGroup(t *testing.T) {
	e := queryEnv(t, 5*time.Second)
	a, token := e.register("ios")
	b, _ := e.register("android")
	outsider, _ := e.register("ios")
	e.pair(a, b, linkA)
	msg := e.card(token, true)

	if out := wait(t, e.query(outsider, msg, "x")); out.ErrorCode != 404 {
		t.Errorf("outsider = %+v", out)
	}
	res := e.query(b, msg, "from b")
	var ups []update
	for len(ups) == 0 {
		ups = e.updates(token, "")
	}
	must[bool](t, e.do("POST", "/bot"+token+"/answerWidgetQuery", "", map[string]any{"widget_query_id": ups[0].WidgetQuery.ID, "data": "for b"}))
	if out := wait(t, res); !out.OK || string(out.Result) != `{"data":"for b"}` {
		t.Errorf("b's answer = %+v", out)
	}
}
