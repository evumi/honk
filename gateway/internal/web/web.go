// Package web serves the gateway's own pages: the landing page at / and the
// API docs at /docs. They are static HTML, CSS, JavaScript and fonts embedded
// in the binary (site/), written by hand: no build step, no runtime.
//
// Every file gets a sha256 ETag and Cache-Control: no-cache, so a browser
// revalidates (a 304) and an upgraded gateway is never served stale assets.
// Text files are gzipped once at start and sent compressed to clients that
// accept gzip. The pages load nothing from other origins; the CSP says so.
package web

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed all:site
var files embed.FS

// csp is sent with the HTML pages: everything comes from this gateway, and the
// only request a page makes is GET /v1/info on the same origin.
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
	"connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

type file struct {
	body  []byte
	gz    []byte // body gzipped, when that is smaller; nil for fonts and the like
	ctype string
	etag  string
	html  bool
}

// Site serves the embedded pages. Paths it does not know are 404.
type Site struct {
	files map[string]file
}

// pages maps the clean URLs to their files.
var pages = map[string]string{"/": "index.html", "/docs": "docs.html"}

// New reads the embedded files.
func New() *Site {
	s := &Site{files: map[string]file{}}
	err := fs.WalkDir(files, "site", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		body, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		ext := path.Ext(p)
		ctype := mime.TypeByExtension(ext)
		switch ext { // the system's MIME table may lack these
		case ".woff2":
			ctype = "font/woff2"
		case ".svg":
			ctype = "image/svg+xml"
		case ".txt", ".sh": // install.sh reads as text in a browser
			ctype = "text/plain; charset=utf-8"
		}
		if ctype == "" {
			ctype = "application/octet-stream"
		}
		sum := sha256.Sum256(body)
		name := strings.TrimPrefix(p, "site")
		f := file{body: body, ctype: ctype, etag: hex.EncodeToString(sum[:12]), html: ext == ".html"}
		if strings.HasPrefix(ctype, "text/") || ctype == "image/svg+xml" {
			f.gz = gzipped(body)
		}
		s.files[name] = f
		return nil
	})
	if err != nil {
		panic("web: reading embedded site: " + err.Error()) // the files are compiled in
	}
	for url, name := range pages {
		s.files[url] = s.files["/"+name]
	}
	// Only the clean URLs serve the pages.
	for _, name := range pages {
		delete(s.files, "/"+name)
	}
	return s
}

// Routes are the patterns the API router hands to the site: the pages, the
// favicon, the command line's install script and everything under /assets/.
func (s *Site) Routes() []string {
	return []string{"/", "/docs", "/favicon.svg", "/install.sh", "/assets/*"}
}

// gzipped returns b compressed, or nil when that saves nothing.
func gzipped(b []byte) []byte {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	zw.Write(b)
	zw.Close()
	if buf.Len() >= len(b) {
		return nil
	}
	return buf.Bytes()
}

// acceptsGzip reports whether Accept-Encoding allows gzip: named with a q
// above 0, or else matched by "*" with a q above 0.
func acceptsGzip(r *http.Request) bool {
	gzip, star := -1, -1 // -1 absent, 0 refused, 1 allowed
	for _, v := range r.Header.Values("Accept-Encoding") {
		for _, part := range strings.Split(v, ",") {
			name, params, _ := strings.Cut(part, ";")
			ok := 1
			if q, found := strings.CutPrefix(strings.ReplaceAll(strings.ToLower(params), " ", ""), "q="); found && strings.Trim(q, "0.") == "" {
				ok = 0
			}
			switch name = strings.TrimSpace(name); {
			case strings.EqualFold(name, "gzip"):
				gzip = ok
			case name == "*":
				star = ok
			}
		}
	}
	if gzip >= 0 {
		return gzip == 1
	}
	return star == 1
}

func (s *Site) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	f, found := s.files[r.URL.Path]
	if !found {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	body, etag := f.body, `"`+f.etag+`"`
	if f.gz != nil {
		h.Set("Vary", "Accept-Encoding")
		if acceptsGzip(r) {
			// A different representation needs its own ETag.
			body, etag = f.gz, `"`+f.etag+`-gz"`
			h.Set("Content-Encoding", "gzip")
		}
	}
	h.Set("Content-Type", f.ctype)
	h.Set("ETag", etag)
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	if f.html {
		h.Set("Content-Security-Policy", csp)
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
	}
	// ServeContent answers If-None-Match with 304, ranges and HEAD.
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
}
