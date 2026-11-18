// Package hooks turns the webhook payloads of other tools into sendMessage
// parameters, for /bot<token>/hook/<kind>.
//
// Each kind is a pure function from the request (body, query, headers, path)
// to url.Values with the bot API's parameter names (title, body, id, level,
// group, url, copy, icon, html, data). The API then validates and delivers
// the result exactly like a sendMessage call, so token auth, the rate limit
// and the widget whitelist apply unchanged.
package hooks

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"
)

// Request is what a converter sees.
type Request struct {
	Body   []byte
	Query  url.Values
	Header http.Header
	Rest   []string // decoded path segments after /hook/<kind>
}

// Func converts one request.
type Func func(Request) (url.Values, error)

// Errors. ErrIgnored means the event is valid but carries nothing to show
// (GitHub's ping, an empty Alertmanager group); the API answers ok and sends
// nothing. Other errors are the caller's malformed input.
var (
	ErrIgnored = errors.New("ignored")
	ErrUnknown = errors.New("unknown hook kind")
)

var kinds = map[string]Func{
	"slack":        Slack,
	"alertmanager": Alertmanager,
	"grafana":      Grafana,
	"github":       GitHub,
	"bark":         Bark,
	"json":         JSON,
}

// Kinds lists the supported kind names.
func Kinds() []string {
	return []string{"slack", "alertmanager", "grafana", "github", "bark", "json"}
}

// overridable query parameters: a sender that cannot shape the payload can
// still set these in the hook URL, e.g. ?level=passive&group=ci.
var overridable = []string{"level", "group", "icon", "copy", "url", "title", "dry_run", "ttl"}

// Convert runs the converter for kind.
func Convert(kind string, r Request) (url.Values, error) {
	f, ok := kinds[strings.ToLower(kind)]
	if !ok {
		return nil, ErrUnknown
	}
	out, err := f(r)
	if err != nil {
		return nil, err
	}
	if k := strings.ToLower(kind); k != "json" && k != "bark" { // these read the query themselves
		for _, k := range overridable {
			if v := r.Query.Get(k); v != "" {
				out.Set(k, v)
			}
		}
	}
	if strings.TrimSpace(out.Get("body")) == "" {
		if t := strings.TrimSpace(out.Get("title")); t != "" {
			out.Set("body", t)
		} else {
			out.Set("body", kind)
		}
	}
	return out, nil
}

// trunc shortens s to at most n runes, ending in an ellipsis.
func trunc(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

func set(v url.Values, k, s string) {
	if s = strings.TrimSpace(s); s != "" {
		v.Set(k, s)
	}
}

// firstNonEmpty returns the first argument that is not blank.
func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}
