package api

import (
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/evumi/honk/gateway/internal/store"
)

func TestDryRunValidatesWithoutSending(t *testing.T) {
	e := setup(t)
	_, token := e.register("ios")
	r := e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{
		"body": "x", "dry_run": true,
		"html": `<div onclick="x()"><iframe src="https://e"></iframe><b>hi</b></div>`,
	})
	res := must[struct {
		DryRun     bool     `json:"dry_run"`
		HTML       string   `json:"html"`
		Raw        int      `json:"raw_size"`
		Compressed int      `json:"compressed_size"`
		Removed    []string `json:"removed"`
	}](t, r)
	if !res.DryRun || res.HTML != "<div><b>hi</b></div>" || res.Raw != len(res.HTML) || res.Compressed == 0 || len(res.Removed) != 2 {
		t.Fatalf("result = %+v", res)
	}
	if len(e.pusher.sent) != 0 {
		t.Error("dry_run pushed")
	}
	// Nothing queued; and an invalid card still fails.
	if r := e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{"body": "x", "dry_run": "true", "html": "<p>\x00</p>"}); r.OK || r.ErrorCode != 400 {
		t.Errorf("invalid dry run: %+v", r)
	}
	if r := e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{"dry_run": true}); r.OK {
		t.Error("dry_run skipped validation of body")
	}
}

func TestHookRoute(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 100})
	_, token := e.register("ios")
	base := "/bot" + token + "/hook/"

	// Alertmanager: firing then resolved replace each other (same id).
	am := `{"version":"4","groupKey":"{}:{alertname=\"X\"}","status":"firing","receiver":"honk","groupLabels":{"alertname":"X"},"commonLabels":{"alertname":"X"},"commonAnnotations":{},"alerts":[{"status":"firing","labels":{"alertname":"X"},"annotations":{"summary":"boom"}}]}`
	m1 := must[store.Message](t, e.do("POST", base+"alertmanager", "", rawJSON(am)))
	if m1.Title != "[FIRING:1] X" || !strings.Contains(m1.HTML, "FIRING 1") || m1.CollapseID == "" {
		t.Fatalf("m1 = %+v", m1)
	}
	m2 := must[store.Message](t, e.do("POST", base+"alertmanager", "", rawJSON(strings.ReplaceAll(am, `"firing"`, `"resolved"`))))
	if m2.CollapseID != m1.CollapseID || m2.Title != "[RESOLVED] X" || m2.Level != "passive" {
		t.Fatalf("m2 = %+v", m2)
	}
	if n := e.pusher.last(t); n.Title != "[RESOLVED] X" {
		t.Errorf("push = %+v", n)
	}

	// Bark path form, with Bark's key segment and percent escapes.
	m3 := must[store.Message](t, e.do("GET", base+"bark/KEY/"+url.PathEscape("T / 标题")+"/"+url.PathEscape("正文 body"), "", nil))
	if m3.Title != "T / 标题" || m3.Body != "正文 body" {
		t.Errorf("bark = %+v", m3)
	}
	// json kind with the query as field map.
	m4 := must[store.Message](t, e.do("POST", base+"json?title=$.a.b&body=$.c&group=ci", "", rawJSON(`{"a":{"b":"T"},"c":"B"}`)))
	if m4.Title != "T" || m4.Body != "B" || m4.Group != "ci" {
		t.Errorf("json = %+v", m4)
	}
	// Ignored events answer ok without queueing.
	before := len(e.pusher.sent)
	if r := e.do("POST", base+"github", "", rawJSON(`{}`)); r.ErrorCode != 400 {
		t.Errorf("github without event header: %+v", r)
	}
	req := e.do("POST", base+"slack", "", rawJSON(`{}`))
	if !req.OK || len(e.pusher.sent) != before {
		t.Errorf("ignored slack: %+v", req)
	}
	// Errors: unknown kind, bad token, over-long field still validated.
	if r := e.do("POST", base+"nope", "", rawJSON(`{}`)); r.ErrorCode != 404 {
		t.Errorf("unknown kind: %+v", r)
	}
	if r := e.do("POST", "/bot1:bad/hook/slack", "", rawJSON(`{"text":"x"}`)); r.ErrorCode != 401 {
		t.Errorf("bad token: %+v", r)
	}
	long := strings.Repeat("x", 300)
	if r := e.do("POST", base+"json?id=a&group="+long, "", rawJSON(`{}`)); r.OK {
		t.Error("over-long group accepted")
	}
}

type rawJSON string

func (r rawJSON) MarshalJSON() ([]byte, error) { return []byte(r), nil }
