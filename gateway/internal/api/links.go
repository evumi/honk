package api

import (
	"errors"
	"net/http"

	"github.com/evumi/honk/gateway/internal/store"
)

// Pairing (device groups). The gateway never sees the pairing code: the
// devices derive link_id and the bundle's key from it (see docs/DESIGN.zh-CN.md).
const (
	maxBundle = 16 << 10 // bytes of the base64url text
	maxLinkID = 64
)

func base64URL(v string) bool {
	for _, c := range v {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return v != ""
}

// createLink (POST /v1/links) stores a bundle for another device to claim.
func (s *Server) createLink(w http.ResponseWriter, r *http.Request) {
	var in struct {
		LinkID string `json:"link_id"`
		Bundle string `json:"bundle"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if len(in.LinkID) < 16 || len(in.LinkID) > maxLinkID || !base64URL(in.LinkID) {
		s.fail(w, r, badRequest("link_id must be 16 to 64 base64url characters"))
		return
	}
	if len(in.Bundle) > maxBundle || !base64URL(in.Bundle) {
		s.fail(w, r, badRequest("bundle must be base64url text of at most 16 KB"))
		return
	}
	err := s.store.CreateLink(r.Context(), device(r).OwnerID, in.LinkID, in.Bundle, s.opts.LinkTTL)
	if errors.Is(err, store.ErrConflict) {
		err = apiError{http.StatusConflict, "Conflict: link_id is in use"}
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, map[string]any{"expires_in": int(s.opts.LinkTTL.Seconds())})
}

// claimLink (POST /v1/links/claim) joins the caller's device group to the one
// that made the link, and returns the bundle. A link works once.
func (s *Server) claimLink(w http.ResponseWriter, r *http.Request) {
	var in struct {
		LinkID string `json:"link_id"`
	}
	if err := decode(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.allowClaim(r) {
		s.fail(w, r, apiError{http.StatusTooManyRequests, "Too Many Requests: too many pairing attempts from this address"})
		return
	}
	if len(in.LinkID) > maxLinkID || !base64URL(in.LinkID) {
		s.fail(w, r, errNotFound)
		return
	}
	bundle, err := s.store.ClaimLink(r.Context(), in.LinkID, device(r).ID, s.opts.MaxBotsPerDevice)
	switch {
	case errors.Is(err, store.ErrTooManyBots):
		err = badRequest("the two device groups together would have more bots than this gateway allows")
	case errors.Is(err, store.ErrNotFound):
		err = apiError{http.StatusNotFound, "Not Found: the pairing code is wrong, expired or already used"}
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok(w, map[string]any{"bundle": bundle})
}
