// Package push wakes a device through APNs (iOS) or FCM (Android).
//
// A push carries only what the banner needs and the message id; the device
// fetches the full message, card included, from the gateway's queue.
package push

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"strconv"
	"unicode/utf8"
)

// ErrTokenGone means APNs or FCM no longer knows the push token: the app was
// removed or the token was rotated.
var ErrTokenGone = errors.New("push token is no longer valid")

// Notification is one push to one device.
type Notification struct {
	Platform  string // ios | android
	Token     string
	Kind      string // message | edit | delete
	MessageID int64
	TargetID  int64 // edit/delete: the message it applies to
	BotID     int64
	BotName   string
	Title     string
	Body      string
	Group     string
	Level     string // passive | active | timeSensitive
	// CollapseID is the sender's id for replaceable messages, unique per bot.
	CollapseID string
}

// Silent reports whether the push should not show anything by itself.
func (n Notification) Silent() bool { return n.Kind != "message" }

// Pusher sends one notification.
type Pusher interface {
	Push(ctx context.Context, n Notification) error
}

// Router sends each notification through the pusher for its platform. A
// platform with no pusher configured is logged and skipped.
type Router struct {
	APNs Pusher
	FCM  Pusher
	Log  *slog.Logger
}

// Push implements Pusher.
func (r Router) Push(ctx context.Context, n Notification) error {
	var p Pusher
	switch n.Platform {
	case "ios":
		p = r.APNs
	case "android":
		p = r.FCM
	}
	if p == nil {
		if r.Log != nil {
			r.Log.Info("push skipped: platform not configured", "platform", n.Platform, "kind", n.Kind, "message_id", n.MessageID)
		}
		return nil
	}
	return p.Push(ctx, n)
}

// maxBannerBody keeps the push well under the 4 KB payload limit of both
// services; the device fetches the full text.
const maxBannerBody = 1500

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	s = s[:max]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s + "…"
}

// collapseKey scopes the sender's id to the bot, since APNs collapses per app,
// and keeps it within APNs's 64-byte limit.
func collapseKey(botID int64, id string) string {
	if id == "" {
		return ""
	}
	k := "b" + strconv.FormatInt(botID, 10) + ":" + id
	if len(k) <= 64 {
		return k
	}
	h := sha256.Sum256([]byte(id))
	return "b" + strconv.FormatInt(botID, 10) + ":" + hex.EncodeToString(h[:16])
}
