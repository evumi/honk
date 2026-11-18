package api

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/evumi/honk/gateway/internal/hooks"
	"github.com/evumi/honk/gateway/internal/store"
)

// authBot resolves the bot token in the first path segment ("bot<token>"). On
// failure it has already answered.
func (s *Server) authBot(w http.ResponseWriter, r *http.Request) (store.Bot, store.Device, bool) {
	seg := chi.URLParam(r, "bot")
	if !strings.HasPrefix(seg, "bot") {
		s.fail(w, r, errNotFound)
		return store.Bot{}, store.Device{}, false
	}
	bot, dev, err := s.store.BotByToken(r.Context(), strings.TrimPrefix(seg, "bot"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			err = errUnauthorized
		}
		s.fail(w, r, err)
		return store.Bot{}, store.Device{}, false
	}
	return bot, dev, true
}

// hook serves /bot<token>/hook/<kind>[/rest...]: the payload of another tool
// (Slack, Alertmanager, GitHub, ...) is converted to sendMessage parameters
// and goes through the same validation, rate limit and delivery.
func (s *Server) hook(w http.ResponseWriter, r *http.Request) {
	bot, dev, good := s.authBot(w, r)
	if !good {
		return
	}
	kind := chi.URLParam(r, "kind")
	var body []byte
	if r.Body != nil {
		var err error
		if body, err = io.ReadAll(r.Body); err != nil {
			s.fail(w, r, badRequest("request body too large or unreadable"))
			return
		}
	}
	// Path segments after /hook/<kind>, still escaped in the URL.
	var rest []string
	esc := r.URL.EscapedPath()
	if i := strings.Index(esc, "/hook/"); i >= 0 {
		tail := strings.TrimPrefix(esc[i+len("/hook/"):], kind)
		for _, seg := range strings.Split(strings.Trim(tail, "/"), "/") {
			if seg == "" {
				continue
			}
			if d, err := url.PathUnescape(seg); err == nil {
				seg = d
			}
			rest = append(rest, seg)
		}
	}
	p, err := hooks.Convert(kind, hooks.Request{Body: body, Query: r.URL.Query(), Header: r.Header, Rest: rest})
	switch {
	case errors.Is(err, hooks.ErrIgnored):
		ok(w, map[string]any{"ignored": true})
		return
	case errors.Is(err, hooks.ErrUnknown):
		s.fail(w, r, errNotFound)
		return
	case err != nil:
		s.fail(w, r, badRequest(err.Error()))
		return
	}
	s.sendMessage(w, r, bot, dev, p)
}
