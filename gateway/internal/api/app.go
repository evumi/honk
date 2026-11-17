package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/evumi/honk/gateway/internal/store"
)

type ctxKey struct{}

const (
	maxBotName   = 64
	maxAvatar    = 512
	maxPushToken = 4096
	syncLimit    = 100
	maxSyncLimit = 500
)

// deviceAuth resolves "Authorization: Bearer <device secret>".
func (s *Server) deviceAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secret := bearer(r)
		if secret == "" {
			s.fail(w, r, errUnauthorized)
			return
		}
		d, err := s.store.DeviceBySecret(r.Context(), secret)
		if err != nil {
			if err == store.ErrNotFound {
				err = errUnauthorized
			}
			s.fail(w, r, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, d)))
	})
}

func device(r *http.Request) store.Device { return r.Context().Value(ctxKey{}).(store.Device) }

func decode(r *http.Request, v any) error {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return badRequest("invalid JSON body")
	}
	return nil
}

// ---- devices ----

func (s *Server) registerDevice(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Platform  string `json:"platform"`
		PushToken string `json:"push_token"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.allowRegistration(r) {
		s.fail(w, r, apiError{http.StatusTooManyRequests, "Too Many Requests: too many devices registered from this address"})
		return
	}
	if in.Platform != "ios" && in.Platform != "android" {
		s.fail(w, r, badRequest("platform must be ios or android"))
		return
	}
	if err := checkPushToken(in.PushToken); err != nil {
		s.fail(w, r, err)
		return
	}
	d, secret, err := s.store.CreateDevice(r.Context(), in.Platform, in.PushToken)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, map[string]any{"device": d, "device_secret": secret})
}

func checkPushToken(t string) error {
	if t == "" || len(t) > maxPushToken {
		return badRequest("push_token is required")
	}
	return nil
}

func (s *Server) getDevice(w http.ResponseWriter, r *http.Request) { ok(w, device(r)) }

func (s *Server) updateDevice(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PushToken string `json:"push_token"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := checkPushToken(in.PushToken); err != nil {
		s.fail(w, r, err)
		return
	}
	d := device(r)
	if err := s.store.UpdatePushToken(r.Context(), d.ID, in.PushToken); err != nil {
		s.fail(w, r, err)
		return
	}
	d.PushToken, d.PushOK = in.PushToken, true
	ok(w, d)
}

func (s *Server) deleteDevice(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteDevice(r.Context(), device(r).ID); err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, true)
}

// ---- bots ----

func botID(r *http.Request) (string, error) {
	id := chi.URLParam(r, "id")
	if !store.ValidBotID(id) {
		return "", errNotFound
	}
	return id, nil
}

func checkBotFields(name, avatar, lvl *string) error {
	if name != nil {
		*name = strings.TrimSpace(*name)
		if *name == "" || utf8.RuneCountInString(*name) > maxBotName {
			return badRequest(fmt.Sprintf("name must be 1 to %d characters", maxBotName))
		}
	}
	if avatar != nil && len(*avatar) > maxAvatar {
		return badRequest(fmt.Sprintf("avatar is longer than %d bytes", maxAvatar))
	}
	if lvl != nil {
		v, err := level(*lvl, "active")
		if err != nil {
			return err
		}
		*lvl = v
	}
	return nil
}

func (s *Server) listBots(w http.ResponseWriter, r *http.Request) {
	bots, err := s.store.ListBots(r.Context(), device(r).ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, bots)
}

func (s *Server) createBot(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name         string `json:"name"`
		Avatar       string `json:"avatar"`
		DefaultLevel string `json:"default_level"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := checkBotFields(&in.Name, &in.Avatar, &in.DefaultLevel); err != nil {
		s.fail(w, r, err)
		return
	}
	if n, err := s.store.CountBots(r.Context(), device(r).ID); err != nil {
		s.fail(w, r, err)
		return
	} else if n >= s.opts.MaxBotsPerDevice {
		s.fail(w, r, badRequest(fmt.Sprintf("a device can have at most %d bots", s.opts.MaxBotsPerDevice)))
		return
	}
	b, token, err := s.store.CreateBot(r.Context(), device(r).ID, in.Name, in.Avatar, in.DefaultLevel)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, map[string]any{"bot": b, "token": token})
}

func (s *Server) getBot(w http.ResponseWriter, r *http.Request) {
	id, err := botID(r)
	if err == nil {
		var b store.Bot
		if b, err = s.store.GetBot(r.Context(), device(r).ID, id); err == nil {
			ok(w, b)
			return
		}
	}
	s.fail(w, r, err)
}

func (s *Server) updateBot(w http.ResponseWriter, r *http.Request) {
	id, err := botID(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var in struct {
		Name         *string `json:"name"`
		Avatar       *string `json:"avatar"`
		DefaultLevel *string `json:"default_level"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := checkBotFields(in.Name, in.Avatar, in.DefaultLevel); err != nil {
		s.fail(w, r, err)
		return
	}
	b, err := s.store.UpdateBot(r.Context(), device(r).ID, id, store.BotPatch{Name: in.Name, Avatar: in.Avatar, DefaultLevel: in.DefaultLevel})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, b)
}

func (s *Server) deleteBot(w http.ResponseWriter, r *http.Request) {
	id, err := botID(r)
	if err == nil {
		if err = s.store.DeleteBot(r.Context(), device(r).ID, id); err == nil {
			s.forgetBot(id)
			ok(w, true)
			return
		}
	}
	s.fail(w, r, err)
}

func (s *Server) resetBotToken(w http.ResponseWriter, r *http.Request) {
	id, err := botID(r)
	if err == nil {
		var token string
		if token, err = s.store.ResetBotToken(r.Context(), device(r).ID, id); err == nil {
			ok(w, map[string]any{"token": token})
			return
		}
	}
	s.fail(w, r, err)
}

// ---- messages ----

func (s *Server) getMessage(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		s.fail(w, r, errNotFound)
		return
	}
	m, err := s.store.GetMessage(r.Context(), device(r).ID, id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, m)
}

func (s *Server) sync(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cursor, limit := int64(0), syncLimit
	if v := q.Get("cursor"); v != "" {
		c, err := strconv.ParseInt(v, 10, 64)
		if err != nil || c < 0 {
			s.fail(w, r, badRequest("cursor must be a non-negative integer"))
			return
		}
		cursor = c
	}
	if v := q.Get("limit"); v != "" {
		l, err := strconv.Atoi(v)
		if err != nil || l < 1 || l > maxSyncLimit {
			s.fail(w, r, badRequest(fmt.Sprintf("limit must be 1 to %d", maxSyncLimit)))
			return
		}
		limit = l
	}
	msgs, err := s.store.Sync(r.Context(), device(r).ID, cursor, limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	next := cursor
	if len(msgs) > 0 {
		next = msgs[len(msgs)-1].ID
	}
	ok(w, map[string]any{"messages": msgs, "cursor": next, "has_more": len(msgs) == limit})
}

func (s *Server) ack(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UpTo int64 `json:"up_to"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if in.UpTo <= 0 {
		s.fail(w, r, badRequest("up_to must be a positive message id"))
		return
	}
	n, err := s.store.Ack(r.Context(), device(r).ID, in.UpTo)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, map[string]any{"acked": n})
}
