package api

import (
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/evumi/honk/gateway/internal/store"
)

type fakeSite struct{}

func (fakeSite) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	io.WriteString(w, "site "+r.URL.Path)
}
func (fakeSite) Routes() []string {
	return []string{"/", "/docs", "/favicon.svg", "/install.sh", "/assets/*"}
}

// The landing page and docs sit next to /bot<token>/<method> without taking
// any of its paths, and are 404 when the site is off.
func TestSiteRoutes(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, Site: fakeSite{}})
	_, token := e.register("ios")

	for _, p := range []string{"/", "/docs", "/favicon.svg", "/install.sh", "/assets/site.css", "/assets/fonts/a.woff2"} {
		res, err := http.Get(e.srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusOK || string(b) != "site "+p {
			t.Errorf("%s: %d %q", p, res.StatusCode, b)
		}
	}
	if b := must[store.Bot](t, e.do("GET", "/bot"+token+"/getMe", "", nil)); b.ID == "" {
		t.Errorf("getMe = %+v", b)
	}
	if r := e.do("GET", "/v1/info", "", nil); !r.OK {
		t.Errorf("/v1/info: %+v", r)
	}
	// Still the bot API's 404, not the site's.
	if r := e.do("GET", "/docs/sendMessage", "", nil); r.OK || r.ErrorCode != http.StatusNotFound {
		t.Errorf("/docs/sendMessage: %+v", r)
	}

	off := setup(t)
	for _, p := range []string{"/", "/docs"} {
		res, err := http.Get(off.srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("site off: %s is %d", p, res.StatusCode)
		}
	}
}
