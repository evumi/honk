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
	"time"
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
	bot, good := s.authBot(w, r)
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
		s.sendMessage(w, r, bot, p)
	case "editmessagedata":
		s.changeMessage(w, r, bot, p, store.KindEdit)
	case "deletemessage":
		s.changeMessage(w, r, bot, p, store.KindDelete)
	case "setwebhook":
		s.setWebhook(w, r, bot, p)
	case "deletewebhook":
		s.removeWebhook(w, r, bot)
	case "getwebhookinfo":
		s.getWebhookInfo(w, bot)
	case "getupdates":
		s.getUpdates(w, r, bot, p)
	case "answerwidgetquery":
		s.answerWidgetQuery(w, r, bot, p)
	default:
		s.fail(w, r, errNotFound)
	}
}

func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request, bot store.Bot, p url.Values) {
	m := store.Message{
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
	if v := p.Get("allow_queries"); v != "" {
		if m.AllowQueries, err = strconv.ParseBool(v); err != nil {
			s.fail(w, r, badRequest("allow_queries must be true or false"))
			return
		}
	}
	if m.Level, err = level(p.Get("level"), bot.DefaultLevel); err != nil {
		s.fail(w, r, err)
		return
	}
	var ttl time.Duration
	if m.OpenMode, m.Image, m.ParseMode, m.Silent, ttl, err = sendOptions(p, s.opts.MessageTTL); err != nil {
		s.fail(w, r, err)
		return
	}
	if m.OpenMode == "url" && m.URL == "" {
		s.fail(w, r, badRequest("open=url needs a url"))
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
	// The push expires with an explicit ttl; otherwise APNs/FCM keep their default.
	var pushExpires time.Time
	if ttl > 0 {
		pushExpires = time.Now().Add(ttl)
	} else {
		ttl = s.opts.MessageTTL
	}
	m, err = s.store.AddMessage(r.Context(), bot, m, ttl)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	banner := m.Body
	if m.ParseMode == "Markdown" {
		banner = StripMarkdown(m.Body)
	}
	s.m.messages.Inc(store.KindMessage)
	s.notifyOwner(r.Context(), bot.OwnerID, push.Notification{
		Kind: store.KindMessage, MessageID: m.ID, BotID: bot.ID, BotName: bot.Name,
		Title: m.Title, Body: banner, Group: m.Group, Level: m.Level, CollapseID: m.CollapseID,
		Quiet: m.Silent, Expires: pushExpires,
	})
	ok(w, m)
}

func (s *Server) changeMessage(w http.ResponseWriter, r *http.Request, bot store.Bot, p url.Values, kind string) {
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
		m, err = s.store.EditData(r.Context(), bot, t, data, s.opts.MessageTTL)
	} else {
		m, err = s.store.DeleteMessage(r.Context(), bot, t, s.opts.MessageTTL)
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.m.messages.Inc(kind)
	s.notifyOwner(r.Context(), bot.OwnerID, push.Notification{
		Kind: kind, MessageID: m.ID, TargetID: m.TargetID, BotID: bot.ID, BotName: bot.Name, CollapseID: m.CollapseID,
	})
	ok(w, true)
}

// minTTL is the shortest ttl a sender can ask for, in seconds.
const minTTL = 60

// sendOptions reads open, image, parse_mode, silent and ttl. A zero ttl means
// the gateway default (HONK_MESSAGE_TTL).
func sendOptions(p url.Values, maxTTL time.Duration) (open, image, parseMode string, silent bool, ttl time.Duration, err error) {
	switch strings.ToLower(p.Get("open")) {
	case "", "chat":
	case "url":
		open = "url"
	default:
		return "", "", "", false, 0, badRequest("open must be chat or url")
	}
	image = p.Get("image")
	if err = checkURL("image", image, true); err != nil {
		return
	}
	switch strings.ToLower(p.Get("parse_mode")) {
	case "":
	case "markdown":
		parseMode = "Markdown"
	default:
		return "", "", "", false, 0, badRequest("parse_mode must be Markdown")
	}
	switch strings.ToLower(p.Get("silent")) {
	case "", "false", "0":
	case "true", "1":
		silent = true
	default:
		return "", "", "", false, 0, badRequest("silent must be true or false")
	}
	if v := p.Get("ttl"); v != "" {
		secs, perr := strconv.ParseInt(v, 10, 64)
		if perr != nil || secs < minTTL || time.Duration(secs)*time.Second > maxTTL {
			return "", "", "", false, 0, badRequest(fmt.Sprintf("ttl must be between %d and %d seconds", minTTL, int64(maxTTL/time.Second)))
		}
		ttl = time.Duration(secs) * time.Second
	}
	return
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
