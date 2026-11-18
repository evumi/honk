package api

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestRegisterKey(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, RegisterKey: "s3cret"})
	info := must[map[string]any](t, e.do("GET", "/v1/info", "", nil))
	if info["register_key_required"] != true {
		t.Errorf("info = %v", info)
	}
	for _, body := range []map[string]string{
		{"platform": "ios", "push_token": "t"},
		{"platform": "ios", "push_token": "t", "register_key": "nope"},
	} {
		if r := e.do("POST", "/v1/devices", "", body); r.OK || r.ErrorCode != 401 {
			t.Errorf("%v: ok=%v code=%d", body, r.OK, r.ErrorCode)
		}
	}
	must[map[string]any](t, e.do("POST", "/v1/devices", "", map[string]string{"platform": "ios", "push_token": "t", "register_key": "s3cret"}))
}

func TestNoRegisterKeyByDefault(t *testing.T) {
	e := setup(t)
	info := must[map[string]any](t, e.do("GET", "/v1/info", "", nil))
	if _, found := info["register_key_required"]; found {
		t.Errorf("info = %v", info)
	}
	must[map[string]any](t, e.do("POST", "/v1/devices", "", map[string]string{"platform": "ios", "push_token": "t", "register_key": "ignored"}))
}

func TestMetrics(t *testing.T) {
	e := setup(t)
	_, token := e.register("ios")
	must[map[string]any](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]string{"body": "x"}))
	e.do("GET", "/nope/nope", "", nil)
	srv := httptestServe(t, e.s.Metrics())
	res, err := http.Get(srv)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := string(raw)
	for _, want := range []string{
		`honk_messages_total{kind="message"} 1`,
		`honk_pushes_total{platform="ios",route="direct",result="ok"} 1`,
		"honk_devices 1\n",
		"honk_bots 1\n",
		"honk_push_queue_length 0\n",
		`honk_http_requests_total{class="2xx"}`,
		`honk_http_requests_total{class="4xx"}`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
}

func TestAccessLogHidesTheBotToken(t *testing.T) {
	var buf bytes.Buffer
	e := setup(t)
	e.s.log = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	e.s.opts.AccessLog = true
	_, token := e.register("ios")
	e.do("GET", "/bot"+token+"/getMe", "", nil)
	out := buf.String()
	if strings.Contains(out, token) || !strings.Contains(out, "/bot<token>/getMe") {
		t.Errorf("access log = %s", out)
	}
}
