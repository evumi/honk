package push

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/sideshow/apns2"
	"github.com/sideshow/apns2/token"
)

// APNs sends through Apple Push Notification service with a .p8 key.
type APNs struct {
	client *apns2.Client
	topic  string
}

// NewAPNs loads the .p8 key and connects to the production or sandbox gateway.
func NewAPNs(keyFile, keyID, teamID, topic string, sandbox bool) (*APNs, error) {
	key, err := token.AuthKeyFromFile(keyFile)
	if err != nil {
		return nil, fmt.Errorf("apns key: %w", err)
	}
	c := apns2.NewTokenClient(&token.Token{AuthKey: key, KeyID: keyID, TeamID: teamID})
	if sandbox {
		c = c.Development()
	} else {
		c = c.Production()
	}
	return &APNs{client: c, topic: topic}, nil
}

// apnsPayload builds the JSON body. A message shows a banner and sets
// mutable-content so the Notification Service Extension can fetch the message
// and put the bot's avatar on it; an edit or delete is a background push.
func apnsPayload(n Notification) ([]byte, error) {
	custom := map[string]any{"kind": n.Kind, "msg_id": n.MessageID, "bot_id": n.BotID}
	if n.TargetID > 0 {
		custom["target_id"] = n.TargetID
	}
	if n.CollapseID != "" {
		custom["id"] = n.CollapseID
	}
	if n.Silent() {
		custom["aps"] = map[string]any{"content-available": 1}
		return json.Marshal(custom)
	}
	alert := map[string]any{"title": n.BotName, "body": truncate(n.Body, maxBannerBody)}
	if n.Title != "" {
		alert["subtitle"] = truncate(n.Title, 200)
	}
	aps := map[string]any{
		"alert":           alert,
		"mutable-content": 1,
		"sound":           "default",
		"thread-id":       threadID(n),
	}
	switch n.Level {
	case "passive":
		aps["interruption-level"] = "passive"
		delete(aps, "sound")
	case "timeSensitive":
		aps["interruption-level"] = "time-sensitive"
	default:
		aps["interruption-level"] = "active"
	}
	custom["aps"] = aps
	return json.Marshal(custom)
}

func threadID(n Notification) string {
	if n.Group != "" {
		return "b" + n.BotID + ":" + n.Group
	}
	return "b" + n.BotID
}

// Push implements Pusher.
func (a *APNs) Push(ctx context.Context, n Notification) error {
	payload, err := apnsPayload(n)
	if err != nil {
		return err
	}
	req := &apns2.Notification{
		DeviceToken: n.Token,
		Topic:       a.topic,
		Payload:     payload,
		Expiration:  time.Now().Add(24 * time.Hour),
		Priority:    apns2.PriorityHigh,
		PushType:    apns2.PushTypeAlert,
		CollapseID:  collapseKey(n.BotID, n.CollapseID),
	}
	if n.Silent() {
		req.Priority = apns2.PriorityLow
		req.PushType = apns2.PushTypeBackground
		req.CollapseID = ""
	} else if n.Level == "passive" {
		req.Priority = apns2.PriorityLow
	}
	res, err := a.client.PushWithContext(ctx, req)
	if err != nil {
		return &RetryableError{Err: fmt.Errorf("apns: %w", err)}
	}
	if res.Sent() {
		return nil
	}
	if res.StatusCode == http.StatusGone || res.Reason == apns2.ReasonBadDeviceToken || res.Reason == apns2.ReasonUnregistered {
		return ErrTokenGone
	}
	err = fmt.Errorf("apns: %d %s", res.StatusCode, res.Reason)
	if retryableStatus(res.StatusCode) {
		return &RetryableError{Err: err}
	}
	return err
}
