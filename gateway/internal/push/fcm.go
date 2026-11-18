package push

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"golang.org/x/oauth2/google"
)

const fcmScope = "https://www.googleapis.com/auth/firebase.messaging"

// FCM sends data messages through the Firebase Cloud Messaging HTTP v1 API.
// Data messages (not notification messages) let the app build every
// notification itself: the bot's avatar, a channel per bot.
type FCM struct {
	client   *http.Client
	endpoint string
	// Bare sends no bot name, title, body or group (HONK_PUSH_CONTENT=none).
	Bare bool
}

// NewFCM reads a service account JSON file.
func NewFCM(ctx context.Context, credentialsFile string) (*FCM, error) {
	data, err := os.ReadFile(credentialsFile)
	if err != nil {
		return nil, fmt.Errorf("fcm credentials: %w", err)
	}
	var sa struct {
		ProjectID string `json:"project_id"`
	}
	if err := json.Unmarshal(data, &sa); err != nil || sa.ProjectID == "" {
		return nil, fmt.Errorf("fcm credentials: no project_id in %s", credentialsFile)
	}
	conf, err := google.JWTConfigFromJSON(data, fcmScope)
	if err != nil {
		return nil, fmt.Errorf("fcm credentials: %w", err)
	}
	return &FCM{
		client:   conf.Client(ctx),
		endpoint: "https://fcm.googleapis.com/v1/projects/" + sa.ProjectID + "/messages:send",
	}, nil
}

func fcmMessage(n Notification) map[string]any {
	data := map[string]string{
		"kind":   n.Kind,
		"msg_id": strconv.FormatInt(n.MessageID, 10),
		"bot_id": n.BotID,
	}
	if !n.Bare {
		data["bot_name"] = n.BotName
	}
	if n.TargetID > 0 {
		data["target_id"] = strconv.FormatInt(n.TargetID, 10)
	}
	if n.CollapseID != "" && !n.Bare {
		data["id"] = n.CollapseID
	}
	priority := "HIGH"
	if !n.Silent() {
		if !n.Bare {
			data["title"] = truncate(n.Title, 200)
			data["body"] = truncate(n.Body, maxBannerBody)
			data["group"] = n.Group
		}
		data["level"] = n.Level
		if n.Level == "passive" {
			priority = "NORMAL"
		}
	} else {
		priority = "NORMAL"
	}
	android := map[string]any{"priority": priority, "ttl": "86400s"}
	if k := n.key(); k != "" && !n.Silent() {
		android["collapse_key"] = k
	}
	return map[string]any{"message": map[string]any{"token": n.Token, "data": data, "android": android}}
}

// Push implements Pusher.
func (f *FCM) Push(ctx context.Context, n Notification) error {
	n.Bare = n.Bare || f.Bare
	body, err := json.Marshal(fcmMessage(n))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := f.client.Do(req)
	if err != nil {
		return &RetryableError{Err: fmt.Errorf("fcm: %w", err)}
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusOK {
		io.Copy(io.Discard, res.Body)
		return nil
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	err = fcmError(res.StatusCode, raw)
	if secs, e := strconv.Atoi(res.Header.Get("Retry-After")); e == nil && secs > 0 {
		var re *RetryableError
		if errors.As(err, &re) {
			re.After = time.Duration(secs) * time.Second
		}
	}
	return err
}

func fcmError(status int, raw []byte) error {
	var e struct {
		Error struct {
			Status  string `json:"status"`
			Message string `json:"message"`
			Details []struct {
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &e)
	for _, d := range e.Error.Details {
		if d.ErrorCode == "UNREGISTERED" || d.ErrorCode == "SENDER_ID_MISMATCH" {
			return ErrTokenGone
		}
	}
	if status == http.StatusNotFound && e.Error.Status == "NOT_FOUND" {
		return ErrTokenGone
	}
	err := fmt.Errorf("fcm: %d %s %s", status, e.Error.Status, e.Error.Message)
	if retryableStatus(status) {
		return &RetryableError{Err: err}
	}
	return err
}
