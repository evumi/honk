package hooks

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/evumi/honk/gateway/internal/widget"
)

// Sample payloads follow the upstream documentation. Fetched while writing:
// Alertmanager (prometheus.io webhook_config, version 4 field list), Grafana
// (webhook contact point), Bark (URL forms and JSON fields). Written from
// knowledge of the upstream formats, not fetched: Slack incoming webhooks
// (the docs page redirected), GitHub workflow_run/release/push payloads
// (only the issues section of the page was readable), Bark's level values.

const amFiring = `{
  "version": "4",
  "groupKey": "{}:{alertname=\"HighCPU\"}",
  "truncatedAlerts": 0,
  "status": "firing",
  "receiver": "honk",
  "groupLabels": {"alertname": "HighCPU"},
  "commonLabels": {"alertname": "HighCPU", "severity": "critical"},
  "commonAnnotations": {"summary": "CPU above 90%"},
  "externalURL": "https://alertmanager.example.com",
  "alerts": [
    {"status": "firing", "labels": {"alertname": "HighCPU", "instance": "web-1:9100", "severity": "critical"},
     "annotations": {"summary": "CPU above 90%"}, "startsAt": "2026-01-02T03:04:05Z", "endsAt": "0001-01-01T00:00:00Z",
     "generatorURL": "https://prometheus.example.com/graph?g0.expr=up", "fingerprint": "a1b2c3"},
    {"status": "firing", "labels": {"alertname": "HighCPU", "instance": "web-2:9100"},
     "annotations": {}, "startsAt": "2026-01-02T03:04:05Z", "endsAt": "0001-01-01T00:00:00Z",
     "generatorURL": "https://prometheus.example.com/graph", "fingerprint": "d4e5f6"}
  ]
}`

const grafanaOne = `{
  "receiver": "honk",
  "status": "firing",
  "orgId": 1,
  "alerts": [{
    "status": "firing",
    "labels": {"alertname": "DiskFull", "grafana_folder": "Infra"},
    "annotations": {"summary": "Disk almost full"},
    "startsAt": "2026-01-02T03:04:05Z", "endsAt": "0001-01-01T00:00:00Z",
    "generatorURL": "https://grafana.example.com/alerting/grafana/x/view",
    "fingerprint": "9f8e7d6c5b4a",
    "silenceURL": "https://grafana.example.com/alerting/silence/new",
    "dashboardURL": "https://grafana.example.com/d/abc", "panelURL": "https://grafana.example.com/d/abc?viewPanel=2",
    "values": {"B": 93.5, "C": 1}
  }],
  "groupLabels": {}, "commonLabels": {"alertname": "DiskFull"}, "commonAnnotations": {},
  "externalURL": "https://grafana.example.com/", "version": "1", "groupKey": "{}:{}",
  "truncatedAlerts": 0, "title": "[FIRING:1]  (DiskFull Infra)", "state": "alerting", "message": "**Firing**\n\nDisk almost full"
}`

func TestHooks(t *testing.T) {
	gh := func(event string) http.Header { return http.Header{"X-Github-Event": {event}} }
	tests := []struct {
		name   string
		kind   string
		body   string
		query  string
		header http.Header
		rest   []string
		want   map[string]string // exact values
		has    map[string]string // substrings
		absent []string
		err    error
	}{
		{name: "slack text", kind: "slack", body: `{"text":"Deploy <https://ci.example.com/1|#1> done &amp; green"}`,
			want: map[string]string{"body": "Deploy #1 done & green"}, absent: []string{"title"}},
		{name: "slack attachment", kind: "slack",
			body: `{"text":"Build finished","attachments":[{"fallback":"fb","color":"#36a64f","pretext":"Pre","title":"Build 42","title_link":"https://ci.example.com/42","text":"All good","fields":[{"title":"Branch","value":"main","short":true}],"footer":"CI","ts":123}]}`,
			want: map[string]string{"title": "Build 42", "url": "https://ci.example.com/42", "body": "Build finished\nPre\nAll good\nBranch: main"}},
		{name: "slack blocks", kind: "slack", body: `{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"Hello *world*"}},{"type":"divider"}]}`,
			want: map[string]string{"body": "Hello *world*"}},
		{name: "slack legacy form", kind: "slack", body: "payload=" + url.QueryEscape(`{"text":"hi"}`), want: map[string]string{"body": "hi"}},
		{name: "slack empty", kind: "slack", body: `{}`, err: ErrIgnored},
		{name: "slack bad json", kind: "slack", body: `nope`, err: errAny},

		{name: "alertmanager firing", kind: "alertmanager", body: amFiring,
			want: map[string]string{"title": "[FIRING:2] HighCPU", "level": "timeSensitive", "group": "honk", "url": "https://prometheus.example.com/graph?g0.expr=up"},
			has:  map[string]string{"body": "• CPU above 90% (web-1:9100)", "id": "am-", "html": "FIRING 2"}},
		{name: "alertmanager resolved", kind: "alertmanager",
			body: strings.NewReplacer(`"status": "firing"`, `"status": "resolved"`).Replace(amFiring),
			want: map[string]string{"title": "[RESOLVED] HighCPU", "level": "passive"}, has: map[string]string{"html": "RESOLVED"}},
		{name: "alertmanager override level", kind: "alertmanager", body: amFiring, query: "level=passive",
			want: map[string]string{"level": "passive"}},
		{name: "alertmanager no alerts", kind: "alertmanager", body: `{"version":"4","status":"firing","alerts":[]}`, err: ErrIgnored},

		{name: "grafana", kind: "grafana", body: grafanaOne,
			want: map[string]string{"id": "gf-9f8e7d6c5b4a", "title": "[FIRING:1]  (DiskFull Infra)", "level": "active", "url": "https://grafana.example.com/d/abc?viewPanel=2"},
			has:  map[string]string{"body": "Disk almost full"}},

		{name: "github workflow failure", kind: "github", header: gh("workflow_run"),
			body: `{"action":"completed","workflow_run":{"id":10,"workflow_id":77,"name":"CI","display_title":"Fix build","status":"completed","conclusion":"failure","html_url":"https://github.com/o/r/actions/runs/10","head_branch":"main","run_number":42},"repository":{"full_name":"o/r","html_url":"https://github.com/o/r"},"sender":{"login":"octocat"}}`,
			want: map[string]string{"title": "CI: failure", "level": "timeSensitive", "url": "https://github.com/o/r/actions/runs/10", "group": "o/r", "body": "o/r #42 on main\nFix build"},
			has:  map[string]string{"id": "gh-wf-"}},
		{name: "github workflow running", kind: "github", header: gh("workflow_run"),
			body: `{"action":"in_progress","workflow_run":{"workflow_id":77,"name":"CI","status":"in_progress","conclusion":null,"html_url":"https://github.com/o/r/actions/runs/10","head_branch":"main","run_number":42},"repository":{"full_name":"o/r"}}`,
			want: map[string]string{"title": "CI: in_progress", "level": "passive"}},
		{name: "github release", kind: "github", header: gh("release"),
			body: `{"action":"published","release":{"tag_name":"v1.2.0","name":"Honk 1.2","html_url":"https://github.com/o/r/releases/tag/v1.2.0","body":"Notes","prerelease":false},"repository":{"full_name":"o/r"}}`,
			want: map[string]string{"title": "o/r Honk 1.2 published", "body": "Notes", "copy": "v1.2.0", "url": "https://github.com/o/r/releases/tag/v1.2.0"}},
		{name: "github issues", kind: "github", header: gh("issues"),
			body: `{"action":"opened","issue":{"number":7,"title":"It breaks","html_url":"https://github.com/o/r/issues/7","user":{"login":"alice"}},"repository":{"full_name":"o/r"},"sender":{"login":"alice"}}`,
			want: map[string]string{"title": "o/r issue #7 opened", "body": "It breaks (by alice)", "url": "https://github.com/o/r/issues/7"}},
		{name: "github push", kind: "github", header: gh("push"),
			body: `{"ref":"refs/heads/main","compare":"https://github.com/o/r/compare/a...b","commits":[{"message":"one"},{"message":"two"}],"pusher":{"name":"alice"},"head_commit":{"message":"two\n\nmore"},"repository":{"full_name":"o/r"}}`,
			want: map[string]string{"title": "o/r: 2 commit(s) to main", "body": "by alice\ntwo", "url": "https://github.com/o/r/compare/a...b"}},
		{name: "github ping", kind: "github", header: gh("ping"), body: `{"zen":"x"}`, err: ErrIgnored},
		{name: "github other", kind: "github", header: gh("star"), body: `{"action":"created","repository":{"full_name":"o/r"},"sender":{"login":"bob"}}`,
			want: map[string]string{"title": "o/r star created", "body": "star event by bob"}},
		{name: "github no event", kind: "github", body: `{}`, err: errAny},

		{name: "bark body", kind: "bark", rest: []string{"KEY", "hello world"}, want: map[string]string{"body": "hello world"}, absent: []string{"title"}},
		{name: "bark title body", kind: "bark", rest: []string{"KEY", "Title", "Body"}, want: map[string]string{"title": "Title", "body": "Body"}},
		{name: "bark subtitle", kind: "bark", rest: []string{"KEY", "T", "S", "B"}, query: "level=critical&group=g&url=https://x.example&copy=c&icon=https://i.example/a.png",
			want: map[string]string{"title": "T · S", "body": "B", "level": "timeSensitive", "group": "g", "url": "https://x.example", "copy": "c", "icon": "https://i.example/a.png"}},
		{name: "bark push json", kind: "bark", rest: []string{"push"},
			body: `{"title":"Hi","body":"There","badge":1,"sound":"minuet","icon":"https://i.example/a.png","group":"test","url":"https://bark.day.app","device_key":"abc","level":"timeSensitive"}`,
			want: map[string]string{"title": "Hi", "body": "There", "group": "test", "level": "timeSensitive", "url": "https://bark.day.app"}},
		{name: "bark form", kind: "bark", rest: []string{"push"}, body: "title=A&body=B&group=C", want: map[string]string{"title": "A", "body": "B", "group": "C"}},
		{name: "bark empty", kind: "bark", rest: []string{"KEY"}, err: ErrIgnored},
		{name: "bark too long", kind: "bark", rest: []string{"K", "a", "b", "c", "d"}, err: errAny},

		{name: "json paths", kind: "json", body: `{"alert":{"name":"disk","n":3,"ok":false,"tags":["a","b"]},"message":"full","items":[{"t":"x"}]}`,
			query: "title=$.alert.name&body=$.message&group=ci&id=$.items[0].t&level=$.missing",
			want:  map[string]string{"title": "disk", "body": "full", "group": "ci", "id": "x"}, absent: []string{"level"}},
		{name: "json default body", kind: "json", body: "{\n \"a\": 1\n}", query: "title=Hello", want: map[string]string{"title": "Hello", "body": `{"a":1}`}},
		{name: "json number and array", kind: "json", body: `{"n":3,"tags":["a","b"],"l":[{"x":1}]}`, query: "title=$.n&body=$.tags&copy=$.l.0.x",
			want: map[string]string{"title": "3", "body": `["a","b"]`, "copy": "1"}},

		{name: "unknown", kind: "nope", body: `{}`, err: ErrUnknown},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q, _ := url.ParseQuery(tc.query)
			h := tc.header
			if h == nil {
				h = http.Header{}
			}
			got, err := Convert(tc.kind, Request{Body: []byte(tc.body), Query: q, Header: h, Rest: tc.rest})
			if tc.err != nil {
				if err == nil || (tc.err != errAny && !errors.Is(err, tc.err)) {
					t.Fatalf("err = %v, want %v", err, tc.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for k, v := range tc.want {
				if got.Get(k) != v {
					t.Errorf("%s = %q, want %q", k, got.Get(k), v)
				}
			}
			for k, v := range tc.has {
				if !strings.Contains(got.Get(k), v) {
					t.Errorf("%s = %q, want it to contain %q", k, got.Get(k), v)
				}
			}
			for _, k := range tc.absent {
				if got.Get(k) != "" {
					t.Errorf("%s = %q, want empty", k, got.Get(k))
				}
			}
			if got.Get("body") == "" {
				t.Error("body is empty")
			}
			// Whatever a hook builds as a card must pass the whitelist untouched.
			if h := got.Get("html"); h != "" {
				rp, err := widget.Inspect(h)
				if err != nil || len(rp.Removed) != 0 {
					t.Errorf("card rejected: err=%v removed=%v", err, rp.Removed)
				}
			}
		})
	}
}

var errAny = errors.New("any error")

func TestAlertIDIsStable(t *testing.T) {
	firing, _ := Convert("alertmanager", Request{Body: []byte(amFiring), Query: url.Values{}})
	resolved, _ := Convert("alertmanager", Request{Body: []byte(strings.ReplaceAll(amFiring, `"firing"`, `"resolved"`)), Query: url.Values{}})
	if firing.Get("id") == "" || firing.Get("id") != resolved.Get("id") || len(firing.Get("id")) > 128 {
		t.Errorf("ids %q %q", firing.Get("id"), resolved.Get("id"))
	}
}

func TestStatusCardEscapesAndFits(t *testing.T) {
	items := []string{`<img src=x onerror=alert(1)>`, strings.Repeat("long ", 100), "a", "b", "c"}
	card := StatusCard(false, 5, `<script>x</script> title`, items, "https://e.example/?a=1&b=2")
	rp, err := widget.Inspect(card)
	if err != nil || len(rp.Removed) != 0 || strings.Contains(card, "<img") || strings.Contains(card, "<script") {
		t.Fatalf("card: err=%v removed=%v\n%s", err, rp.Removed, card)
	}
	if rp.Compressed > widget.MaxCompressed {
		t.Errorf("compressed %d", rp.Compressed)
	}
}

func TestLookup(t *testing.T) {
	doc := map[string]any{"a": map[string]any{"b": []any{"x", map[string]any{"c": "y"}}}}
	for path, want := range map[string]string{"$.a.b[0]": "x", "$.a.b[1].c": "y", "$.a.b.1.c": "y", "$.a.z": "", "$.a.b[9]": "", "$bad": "", "x": ""} {
		if got := Lookup(doc, path); got != want {
			t.Errorf("Lookup(%q) = %q, want %q", path, got, want)
		}
	}
}
