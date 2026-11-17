package push

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestAPNsPayload(t *testing.T) {
	raw, err := apnsPayload(Notification{Kind: "message", MessageID: 7, BotID: "Kx3", BotName: "部署", Title: "成功", Body: "已上线", Level: "timeSensitive", Group: "prod"})
	if err != nil {
		t.Fatal(err)
	}
	var p struct {
		APS struct {
			Alert   struct{ Title, Subtitle, Body string }
			Mutable int    `json:"mutable-content"`
			Level   string `json:"interruption-level"`
			Thread  string `json:"thread-id"`
		} `json:"aps"`
		MsgID int64 `json:"msg_id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	if p.APS.Alert.Title != "部署" || p.APS.Alert.Subtitle != "成功" || p.APS.Mutable != 1 ||
		p.APS.Level != "time-sensitive" || p.APS.Thread != "bKx3:prod" || p.MsgID != 7 {
		t.Errorf("payload = %s", raw)
	}

	raw, _ = apnsPayload(Notification{Kind: "edit", MessageID: 8, TargetID: 7, BotID: "Kx3"})
	if !strings.Contains(string(raw), `"content-available":1`) || strings.Contains(string(raw), "alert") {
		t.Errorf("silent payload = %s", raw)
	}

	long := strings.Repeat("长", 3000)
	raw, _ = apnsPayload(Notification{Kind: "message", BotName: "b", Body: long})
	if len(raw) > 4096 {
		t.Errorf("payload is %d bytes, over the APNs limit", len(raw))
	}
}

func TestFCMMessage(t *testing.T) {
	m := fcmMessage(Notification{Token: "tok", Kind: "message", MessageID: 7, BotID: "Kx3", Body: "x", Level: "passive", CollapseID: "dep-1"})
	msg := m["message"].(map[string]any)
	data := msg["data"].(map[string]string)
	android := msg["android"].(map[string]any)
	if data["msg_id"] != "7" || data["level"] != "passive" || android["priority"] != "NORMAL" || android["collapse_key"] != "bKx3:dep-1" || data["bot_id"] != "Kx3" {
		t.Errorf("fcm message = %+v", m)
	}
	if _, has := fcmMessage(Notification{Kind: "delete", MessageID: 9})["message"].(map[string]any)["data"].(map[string]string)["body"]; has {
		t.Error("silent FCM message carries a body")
	}
}

func TestFCMErrors(t *testing.T) {
	gone := `{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`
	if err := fcmError(404, []byte(gone)); !errors.Is(err, ErrTokenGone) {
		t.Errorf("UNREGISTERED: %v", err)
	}
	if err := fcmError(500, []byte(`{"error":{"status":"INTERNAL"}}`)); errors.Is(err, ErrTokenGone) || err == nil {
		t.Errorf("INTERNAL: %v", err)
	}
}

func TestCollapseKey(t *testing.T) {
	if k := collapseKey("Kx3", strings.Repeat("x", 200)); len(k) > 64 || !strings.HasPrefix(k, "bKx3:") {
		t.Errorf("long collapse key = %q", k)
	}
	if collapseKey("Kx3", "") != "" {
		t.Error("empty id gave a collapse key")
	}
}
