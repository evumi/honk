package web

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func get(t *testing.T, s *Site, method, path string, header map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, nil)
	for k, v := range header {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestPages(t *testing.T) {
	s := New()
	for _, p := range []string{"/", "/docs"} {
		w := get(t, s, http.MethodGet, p, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d", p, w.Code)
		}
		h := w.Header()
		if !strings.HasPrefix(h.Get("Content-Type"), "text/html") {
			t.Errorf("%s: content type %q", p, h.Get("Content-Type"))
		}
		if !strings.Contains(h.Get("Content-Security-Policy"), "script-src 'self'") || h.Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s: security headers %v", p, h)
		}
		if h.Get("ETag") == "" || h.Get("Cache-Control") != "no-cache" {
			t.Errorf("%s: cache headers %v", p, h)
		}
		w2 := get(t, s, http.MethodGet, p, map[string]string{"If-None-Match": h.Get("ETag")})
		if w2.Code != http.StatusNotModified {
			t.Errorf("%s: revalidation got %d", p, w2.Code)
		}
		if w3 := get(t, s, http.MethodHead, p, nil); w3.Code != http.StatusOK || w3.Body.Len() != 0 {
			t.Errorf("%s: HEAD got %d with %d bytes", p, w3.Code, w3.Body.Len())
		}
	}
	for path, ctype := range map[string]string{
		"/assets/site.css":                     "text/css",
		"/assets/site.js":                      "text/javascript",
		"/assets/fonts/onest-latin-wght.woff2": "font/woff2",
		"/favicon.svg":                         "image/svg+xml",
		"/install.sh":                          "text/plain",
	} {
		w := get(t, s, http.MethodGet, path, nil)
		if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), ctype) {
			t.Errorf("%s: %d %q", path, w.Code, w.Header().Get("Content-Type"))
		}
		if w.Header().Get("Content-Security-Policy") != "" {
			t.Errorf("%s: CSP on an asset", path)
		}
	}
	// The files behind the clean URLs are not served under their own names.
	for _, p := range []string{"/index.html", "/docs.html", "/assets/", "/assets/nope.css", "/docs/"} {
		if w := get(t, s, http.MethodGet, p, nil); w.Code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, w.Code)
		}
	}
	if w := get(t, s, http.MethodPost, "/", nil); w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" {
		t.Errorf("POST /: %d %v", w.Code, w.Header())
	}
}

var (
	localRef = regexp.MustCompile(`(?:href|src)="(/[^"#]*)(?:#([^"]*))?"`)
	cssURL   = regexp.MustCompile(`url\('([^')]+)'\)`)
	ids      = regexp.MustCompile(`\bid="([^"]+)"`)
	inPage   = regexp.MustCompile(`href="#([^"]+)"`)
)

func body(t *testing.T, s *Site, p string) string {
	t.Helper()
	w := get(t, s, http.MethodGet, p, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("%s: %d", p, w.Code)
	}
	return w.Body.String()
}

func idSet(html string) map[string]bool {
	out := map[string]bool{}
	for _, m := range ids.FindAllStringSubmatch(html, -1) {
		out[m[1]] = true
	}
	return out
}

// Every link between the pages and every asset they load exists, and the
// pages keep to the CSP (no inline scripts or style attributes).
func TestLinks(t *testing.T) {
	s := New()
	pages := map[string]string{"/": body(t, s, "/"), "/docs": body(t, s, "/docs")}
	for page, html := range pages {
		for _, m := range localRef.FindAllStringSubmatch(html, -1) {
			target, frag := m[1], m[2]
			if w := get(t, s, http.MethodGet, target, nil); w.Code != http.StatusOK {
				t.Errorf("%s links to %s: %d", page, target, w.Code)
			}
			if frag != "" {
				if other, ok := pages[target]; ok && !idSet(other)[frag] {
					t.Errorf("%s links to %s#%s: no such id", page, target, frag)
				}
			}
		}
		own := idSet(html)
		for _, m := range inPage.FindAllStringSubmatch(html, -1) {
			if !own[m[1]] {
				t.Errorf("%s links to #%s: no such id", page, m[1])
			}
		}
		if strings.Contains(html, " style=\"") {
			t.Errorf("%s has a style attribute, which the CSP blocks", page)
		}
		if regexp.MustCompile(`<script>`).MatchString(html) {
			t.Errorf("%s has an inline script, which the CSP blocks", page)
		}
		// Both languages are written out: every zh span has an en partner.
		if zh, en := strings.Count(html, `class="zh"`), strings.Count(html, `class="en"`); zh != en {
			t.Errorf("%s: %d zh and %d en spans", page, zh, en)
		}
	}
	css := body(t, s, "/assets/site.css")
	for _, m := range cssURL.FindAllStringSubmatch(css, -1) {
		if w := get(t, s, http.MethodGet, "/assets/"+m[1], nil); w.Code != http.StatusOK {
			t.Errorf("site.css loads %s: %d", m[1], w.Code)
		}
	}
}

func TestGzip(t *testing.T) {
	s := New()
	plain := get(t, s, http.MethodGet, "/docs", nil)
	gz := get(t, s, http.MethodGet, "/docs", map[string]string{"Accept-Encoding": "br, gzip"})
	if gz.Header().Get("Content-Encoding") != "gzip" || gz.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("gzip headers %v", gz.Header())
	}
	if gz.Body.Len()*3 > plain.Body.Len() {
		t.Errorf("gzip is %d bytes of %d", gz.Body.Len(), plain.Body.Len())
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(zr)
	if !bytes.Equal(out, plain.Body.Bytes()) {
		t.Error("gzip body does not decode to the page")
	}
	// Each representation revalidates against its own ETag.
	if gz.Header().Get("ETag") == plain.Header().Get("ETag") {
		t.Error("same ETag for both representations")
	}
	if w := get(t, s, http.MethodGet, "/docs", map[string]string{"Accept-Encoding": "gzip", "If-None-Match": gz.Header().Get("ETag")}); w.Code != http.StatusNotModified {
		t.Errorf("gzip revalidation: %d", w.Code)
	}
	// Fonts are compressed already.
	if w := get(t, s, http.MethodGet, "/assets/fonts/lato-latin-400.woff2", map[string]string{"Accept-Encoding": "gzip"}); w.Header().Get("Content-Encoding") != "" || w.Header().Get("Vary") != "" {
		t.Errorf("font: %v", w.Header())
	}
	for ae, want := range map[string]bool{
		"gzip": true, "GZIP;q=0.5": true, "deflate, gzip;q=1.0": true, "*": true, "*;q=0.1": true,
		"": false, "br": false, "gzip;q=0": false, "gzip; q=0.000": false, "*;q=0": false,
		"*, gzip;q=0": false, "gzip;q=0, *": false, "identity, *;q=0, gzip": true,
	} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Accept-Encoding", ae)
		if got := acceptsGzip(r); got != want {
			t.Errorf("Accept-Encoding %q: %v, want %v", ae, got, want)
		}
	}
}

func TestRoutesServe(t *testing.T) {
	s := New()
	for _, p := range s.Routes() {
		p = strings.TrimSuffix(p, "*") + map[bool]string{true: "site.css"}[strings.HasSuffix(p, "*")]
		if w := get(t, s, http.MethodGet, p, nil); w.Code != http.StatusOK {
			t.Errorf("route %s: %d", p, w.Code)
		}
	}
}
