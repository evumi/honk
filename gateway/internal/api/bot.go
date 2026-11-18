package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/evumi/honk/gateway/internal/push"
	"github.com/evumi/honk/gateway/internal/store"
	"github.com/evumi/honk/gateway/internal/widget"
)

// Field limits for bot API parameters.
const (
	maxTitle      = 256  // runes
	maxBody       = 4096 // runes, Telegram's text limit
	maxGroup      = 64
	maxURL        = 2048
	maxCollapseID = 128
)

// botAPI serves /bot<token>/<method> with GET query, form or JSON parameters.
func (s *Server) botAPI(w http.ResponseWriter, r *http.Request) {
	bot, dev, good := s.authBot(w, r)
	if !good {
		return
	}
	p, err := params(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	switch strings.ToLower(chi.URLParam(r, "method")) {
	case "getme":
		ok(w, bot)
	case "sendmessage":
		s.sendMessage(w, r, bot, dev, p)
	case "editmessagedata":
		s.changeMessage(w, r, bot, dev, p, store.KindEdit)
	case "deletemessage":
		s.changeMessage(w, r, bot, dev, p, store.KindDelete)
	default:
		s.fail(w, r, errNotFound)
	}
}

func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request, bot store.Bot, dev store.Device, p url.Values) {
	m := store.Message{
		DeviceID:   dev.ID,
		Title:      strings.TrimSpace(p.Get("title")),
		Body:       strings.TrimSpace(p.Get("body")),
		Data:       p.Get("data"),
		Group:      p.Get("group"),
		URL:        p.Get("url"),
		Copy:       p.Get("copy"),
		Icon:       p.Get("icon"),
		CollapseID: p.Get("id"),
	}
	var err error
	if m.Level, err = level(p.Get("level"), bot.DefaultLevel); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := checkMessage(m); err != nil {
		s.fail(w, r, err)
		return
	}
	rep, err := widget.Inspect(p.Get("html"))
	if err != nil {
		s.fail(w, r, badRequest(err.Error()))
		return
	}
	m.HTML = rep.HTML
	if !s.allow(bot.ID) {
		s.fail(w, r, apiError{http.StatusTooManyRequests, "Too Many Requests"})
		return
	}
	if v := strings.ToLower(p.Get("dry_run")); v == "true" || v == "1" {
		// Validate only: nothing is queued or pushed.
		ok(w, map[string]any{
			"dry_run": true, "level": m.Level, "html": rep.HTML, "input_size": rep.InputSize,
			"raw_size": rep.Raw, "compressed_size": rep.Compressed, "removed": rep.Removed,
		})
		return
	}
	m, err = s.store.AddMessage(r.Context(), bot, m, s.opts.MessageTTL)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.notify(dev, push.Notification{
		Kind: store.KindMessage, MessageID: m.ID, BotID: bot.ID, BotName: bot.Name,
		Title: m.Title, Body: m.Body, Group: m.Group, Level: m.Level, CollapseID: m.CollapseID,
	})
	ok(w, m)
}

func (s *Server) changeMessage(w http.ResponseWriter, r *http.Request, bot store.Bot, dev store.Device, p url.Values, kind string) {
	var t store.Target
	if v := p.Get("message_id"); v != "" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil || id <= 0 {
			s.fail(w, r, badRequest("message_id must be a positive integer"))
			return
		}
		t.MessageID = id
	}
	t.CollapseID = p.Get("id")
	if t.MessageID == 0 && t.CollapseID == "" {
		s.fail(w, r, badRequest("message_id or id is required"))
		return
	}
	if len(t.CollapseID) > maxCollapseID {
		s.fail(w, r, badRequest(fmt.Sprintf("id is longer than %d bytes", maxCollapseID)))
		return
	}
	if !s.allow(bot.ID) {
		s.fail(w, r, apiError{http.StatusTooManyRequests, "Too Many Requests"})
		return
	}
	var m store.Message
	var err error
	if kind == store.KindEdit {
		data := p.Get("data")
		if len(data) > widget.MaxData {
			s.fail(w, r, badRequest(fmt.Sprintf("data is longer than %d bytes", widget.MaxData)))
			return
		}
		m, err = s.store.EditData(r.Context(), bot, dev.ID, t, data, s.opts.MessageTTL)
	} else {
		m, err = s.store.DeleteMessage(r.Context(), bot, dev.ID, t, s.opts.MessageTTL)
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.notify(dev, push.Notification{
		Kind: kind, MessageID: m.ID, TargetID: m.TargetID, BotID: bot.ID, BotName: bot.Name, CollapseID: m.CollapseID,
	})
	ok(w, true)
}

func level(v, def string) (string, error) {
	switch v {
	case "":
		return def, nil
	case "passive", "active", "timeSensitive":
		return v, nil
	case "time-sensitive", "timesensitive":
		return "timeSensitive", nil
	}
	return "", badRequest("level must be passive, active or timeSensitive")
}

func checkMessage(m store.Message) error {
	switch {
	case m.Body == "":
		return badRequest("body is required")
	case utf8.RuneCountInString(m.Title) > maxTitle:
		return badRequest(fmt.Sprintf("title is longer than %d characters", maxTitle))
	case utf8.RuneCountInString(m.Body) > maxBody:
		return badRequest(fmt.Sprintf("body is longer than %d characters", maxBody))
	case len(m.Data) > widget.MaxData:
		return badRequest(fmt.Sprintf("data is longer than %d bytes", widget.MaxData))
	case len(m.Group) > maxGroup:
		return badRequest(fmt.Sprintf("group is longer than %d bytes", maxGroup))
	case utf8.RuneCountInString(m.Copy) > maxBody:
		return badRequest(fmt.Sprintf("copy is longer than %d characters", maxBody))
	case len(m.CollapseID) > maxCollapseID:
		return badRequest(fmt.Sprintf("id is longer than %d bytes", maxCollapseID))
	}
	if err := checkURL("url", m.URL, false); err != nil {
		return err
	}
	return checkURL("icon", m.Icon, true)
}

// checkURL accepts http(s) links; with httpsOnly, only https (the device
// downloads icons, so plain http is refused).
func checkURL(name, v string, httpsOnly bool) error {
	if v == "" {
		return nil
	}
	u, err := url.Parse(v)
	if err != nil || len(v) > maxURL || u.Host == "" || (u.Scheme != "https" && (httpsOnly || u.Scheme != "http")) {
		if httpsOnly {
			return badRequest(name + " must be an https URL")
		}
		return badRequest(name + " must be an http or https URL")
	}
	return nil
}

// params merges the query string with a form or JSON body. A JSON value that
// is not a string (a number, or an object for data) is kept as its JSON text.
func params(r *http.Request) (url.Values, error) {
	p := r.URL.Query()
	if r.Method == http.MethodGet || r.Body == nil {
		return p, nil
	}
	ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	switch ct {
	case "application/json":
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			return nil, badRequest("invalid JSON body")
		}
		for k, raw := range body {
			var s string
			if json.Unmarshal(raw, &s) == nil {
				p.Set(k, s)
			} else if string(raw) != "null" {
				p.Set(k, string(raw))
			}
		}
	case "application/x-www-form-urlencoded", "multipart/form-data":
		if err := r.ParseMultipartForm(64 << 10); err != nil && !errors.Is(err, http.ErrNotMultipart) {
			return nil, badRequest("invalid form body")
		}
		for k, vs := range r.PostForm {
			p[k] = vs
		}
	}
	return p, nil
}
