package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/evumi/honk/gateway/internal/store"
)

type ctxKey struct{}

const (
	maxBotName   = 64
	maxDevName   = 64
	seenEvery    = time.Hour
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
		// seen_at is written at most once an hour.
		if now := time.Now().UnixMilli(); now-d.SeenAt > seenEvery.Milliseconds() {
			if err := s.store.TouchDevice(r.Context(), d.ID); err != nil {
				s.log.Warn("touch device", "err", err)
			}
			d.SeenAt = now
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
		Key       string `json:"register_key"`
		Name      string `json:"name"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.allowRegistration(r) {
		s.fail(w, r, apiError{http.StatusTooManyRequests, "Too Many Requests: too many devices registered from this address"})
		return
	}
	if k := s.opts.RegisterKey; k != "" && subtle.ConstantTimeCompare([]byte(in.Key), []byte(k)) != 1 {
		s.fail(w, r, apiError{http.StatusUnauthorized, "Unauthorized: this gateway needs a register_key"})
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
	name, err := deviceName(in.Name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	d, secret, err := s.store.CreateDevice(r.Context(), in.Platform, in.PushToken, name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, map[string]any{"device": d, "device_secret": secret})
}

// deviceName trims and checks the optional name a device gives itself.
func deviceName(v string) (string, error) {
	v = strings.TrimSpace(v)
	if utf8.RuneCountInString(v) > maxDevName {
		return "", badRequest(fmt.Sprintf("name is longer than %d characters", maxDevName))
	}
	return v, nil
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
		Name      string `json:"name"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if in.PushToken != "" || in.Name == "" {
		if err := checkPushToken(in.PushToken); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	name, err := deviceName(in.Name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	d := device(r)
	if err := s.store.UpdateDevice(r.Context(), d.ID, in.PushToken, name); err != nil {
		s.fail(w, r, err)
		return
	}
	if in.PushToken != "" {
		d.PushToken, d.PushOK = in.PushToken, true
	}
	if name != "" {
		d.Name = name
	}
	ok(w, d)
}

// deleteDevice (DELETE /v1/devices/me) removes this device from its group;
// the last device takes the group, its bots and the queue with it. With
// ?all=true the whole group goes: every device, bot and queued message.
func (s *Server) deleteDevice(w http.ResponseWriter, r *http.Request) {
	d := device(r)
	var err error
	if v := r.URL.Query().Get("all"); v == "true" || v == "1" {
		err = s.store.DeleteOwner(r.Context(), d.OwnerID)
	} else {
		_, err = s.store.DeleteDevice(r.Context(), d.ID)
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, true)
}

// deviceView is what the device list shows of a device.
type deviceView struct {
	store.Device
	Current bool `json:"current"`
}

// listDevices (GET /v1/devices) lists the devices of the caller's group.
func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	me := device(r)
	ds, err := s.store.ListDevices(r.Context(), me.OwnerID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := make([]deviceView, len(ds))
	for i, d := range ds {
		out[i] = deviceView{Device: d, Current: d.ID == me.ID}
	}
	ok(w, out)
}

// removeDevice (DELETE /v1/devices/{id}) removes one device of the caller's group.
func (s *Server) removeDevice(w http.ResponseWriter, r *http.Request) {
	me := device(r)
	id := chi.URLParam(r, "id")
	ds, err := s.store.ListDevices(r.Context(), me.OwnerID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	found := false
	for _, d := range ds {
		found = found || d.ID == id
	}
	if !found {
		s.fail(w, r, errNotFound)
		return
	}
	if _, err := s.store.DeleteDevice(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, true)
}

// ---- bots ----

// botID reads the {id} of /v1/bots/{id}. The integer id a client knew
// before v2 still names the group's own bot: an app whose local rename to the
// short id is still pending (offline at the first sync) can delete or edit it.
func (s *Server) botID(r *http.Request) (string, error) {
	id := chi.URLParam(r, "id")
	if store.ValidBotID(id) {
		return id, nil
	}
	key, err := strconv.ParseUint(id, 10, 63)
	if err != nil || key == 0 {
		return "", errNotFound
	}
	public, err := s.store.BotIDByKey(r.Context(), device(r).OwnerID, int64(key))
	if err == nil {
		s.log.Info("integer bot id", "path", r.URL.Path, "bot", public)
	}
	return public, err
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
	bots, err := s.store.ListBots(r.Context(), device(r).OwnerID)
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
	if n, err := s.store.CountBots(r.Context(), device(r).OwnerID); err != nil {
		s.fail(w, r, err)
		return
	} else if n >= s.opts.MaxBotsPerDevice {
		s.fail(w, r, badRequest(fmt.Sprintf("a device group can have at most %d bots", s.opts.MaxBotsPerDevice)))
		return
	}
	b, token, err := s.store.CreateBot(r.Context(), device(r), in.Name, in.Avatar, in.DefaultLevel)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, map[string]any{"bot": b, "token": token})
}

func (s *Server) getBot(w http.ResponseWriter, r *http.Request) {
	id, err := s.botID(r)
	if err == nil {
		var b store.Bot
		if b, err = s.store.GetBot(r.Context(), device(r).OwnerID, id); err == nil {
			ok(w, b)
			return
		}
	}
	s.fail(w, r, err)
}

func (s *Server) updateBot(w http.ResponseWriter, r *http.Request) {
	id, err := s.botID(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var in struct {
		Name         *string `json:"name"`
		Avatar       *string `json:"avatar"`
		DefaultLevel *string `json:"default_level"`
		Encrypted    *bool   `json:"encrypted"`
		KeyWrapped   *string `json:"key_wrapped"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := checkBotFields(in.Name, in.Avatar, in.DefaultLevel); err != nil {
		s.fail(w, r, err)
		return
	}
	if in.KeyWrapped != nil {
		wrapped, err := checkKeyWrapped(*in.KeyWrapped)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		*in.KeyWrapped = wrapped
	}
	b, err := s.store.UpdateBot(r.Context(), device(r).OwnerID, id, store.BotPatch{Name: in.Name, Avatar: in.Avatar, DefaultLevel: in.DefaultLevel, Encrypted: in.Encrypted, KeyWrapped: in.KeyWrapped})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, b)
}

func (s *Server) deleteBot(w http.ResponseWriter, r *http.Request) {
	id, err := s.botID(r)
	if err == nil {
		if err = s.store.DeleteBot(r.Context(), device(r).OwnerID, id); err == nil {
			s.forgetBot(id)
			ok(w, true)
			return
		}
	}
	s.fail(w, r, err)
}

func (s *Server) resetBotToken(w http.ResponseWriter, r *http.Request) {
	id, err := s.botID(r)
	if err == nil {
		var token string
		if token, err = s.store.ResetBotToken(r.Context(), device(r).OwnerID, id); err == nil {
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
	m, err := s.store.GetMessage(r.Context(), device(r).OwnerID, id)
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
	d := device(r)
	msgs, err := s.store.Sync(r.Context(), d.OwnerID, cursor, limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	next := cursor
	if len(msgs) > 0 {
		next = msgs[len(msgs)-1].ID
	}
	out := map[string]any{"messages": msgs, "cursor": next, "has_more": len(msgs) == limit}
	if d.Resync {
		if cursor == 0 {
			// Starting over is what the flag asks for.
			if err := s.store.ClearResync(r.Context(), d.ID); err != nil {
				s.fail(w, r, err)
				return
			}
		} else {
			out["reset"] = true // the group took in messages below this device's cursor
		}
	}
	ok(w, out)
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
	n, err := s.store.Ack(r.Context(), device(r), in.UpTo)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, map[string]any{"acked": n})
}
