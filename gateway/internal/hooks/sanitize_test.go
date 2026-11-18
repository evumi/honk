package hooks

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestConvertFitsGroupAndURL(t *testing.T) {
	long := strings.Repeat("é", 100) // 200 bytes
	body := `{"receiver":"` + long + `","status":"firing","alerts":[{"status":"firing","labels":{"alertname":"A"},"annotations":{"summary":"s"},"generatorURL":"https://x.example/` + strings.Repeat("a", 3000) + `"}],"externalURL":"https://am.example"}`
	out, err := Convert("alertmanager", Request{Body: []byte(body), Query: url.Values{}, Header: http.Header{}})
	if err != nil {
		t.Fatal(err)
	}
	g := out.Get("group")
	if len(g) > 64 || !utf8.ValidString(g) || g == "" {
		t.Errorf("group = %q (%d bytes)", g, len(g))
	}
	if u := out.Get("url"); len(u) > 2048 {
		t.Errorf("url kept: %d bytes", len(u))
	}

	// A query override and an invalid scheme are fitted too.
	q := url.Values{"group": {long}, "url": {"weixin://x"}}
	out, err = Convert("alertmanager", Request{Body: []byte(body), Query: q, Header: http.Header{}})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Get("group")) > 64 || out.Get("url") != "" {
		t.Errorf("group %d bytes, url %q", len(out.Get("group")), out.Get("url"))
	}

	// A short group and an https URL are left alone.
	v := url.Values{"group": {"ci"}, "url": {"https://a.example/x"}}
	sanitize(v)
	if v.Get("group") != "ci" || v.Get("url") != "https://a.example/x" {
		t.Errorf("v = %v", v)
	}
}
