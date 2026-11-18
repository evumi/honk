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

func TestFCMErrorRetryable(t *testing.T) {
	cases := []struct {
		status int
		body   string
		retry  bool
		gone   bool
	}{
		{503, `{"error":{"status":"UNAVAILABLE"}}`, true, false},
		{429, `{"error":{"status":"QUOTA_EXCEEDED"}}`, true, false},
		{400, `{"error":{"status":"INVALID_ARGUMENT"}}`, false, false},
		{404, `{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`, false, true},
	}
	for _, c := range cases {
		err := fcmError(c.status, []byte(c.body))
		_, retry := Retryable(err)
		if retry != c.retry || errors.Is(err, ErrTokenGone) != c.gone {
			t.Errorf("%d: retry=%v gone=%v, want %v %v (%v)", c.status, retry, errors.Is(err, ErrTokenGone), c.retry, c.gone, err)
		}
	}
}

func TestBarePayloadsCarryNoContent(t *testing.T) {
	n := Notification{Kind: "message", MessageID: 7, BotID: "Kx3", BotName: "部署机器人", Title: "秘密标题", Body: "秘密正文", Group: "prod", Level: "active", CollapseID: "dep-1", Bare: true}
	raw, err := apnsPayload(n)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"部署机器人", "秘密标题", "秘密正文", "prod", "dep-1"} {
		if strings.Contains(string(raw), s) {
			t.Errorf("APNs payload contains %q: %s", s, raw)
		}
	}
	var p struct {
		APS struct {
			Alert   map[string]string
			Mutable int `json:"mutable-content"`
		} `json:"aps"`
		MsgID int64 `json:"msg_id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	if p.APS.Alert["loc-key"] != "New notification" || len(p.APS.Alert) != 1 || p.APS.Mutable != 1 || p.MsgID != 7 {
		t.Errorf("bare payload = %s", raw)
	}

	msg := fcmMessage(n)["message"].(map[string]any)
	data := msg["data"].(map[string]string)
	for _, k := range []string{"bot_name", "title", "body", "group", "id"} {
		if _, has := data[k]; has {
			t.Errorf("bare FCM data has %s", k)
		}
	}
	if data["msg_id"] != "7" || data["bot_id"] != "Kx3" {
		t.Errorf("FCM data = %v", data)
	}
}

func TestPrecomputedCollapseKey(t *testing.T) {
	k := CollapseKeyFor("Kx3", "dep-1")
	if len(k) != 5+32 || !strings.HasPrefix(k, "bKx3:") {
		t.Errorf("key = %q", k)
	}
	android := fcmMessage(Notification{Kind: "message", BotID: "Kx3", CollapseKey: k, Bare: true})["message"].(map[string]any)["android"].(map[string]any)
	if android["collapse_key"] != k {
		t.Errorf("android = %v", android)
	}
}

func TestBarePayloadsStayUnder4KB(t *testing.T) {
	// The longest values the bot API accepts: name and group 64 characters,
	// title 256, body 4096, id 128 bytes.
	long := strings.Repeat("长", 4096)
	n := Notification{Kind: "message", BotID: "Kx3abcde", BotName: strings.Repeat("长", 64), Title: long[:256*3], Body: long,
		Group: strings.Repeat("长", 64), CollapseID: strings.Repeat("i", 128), Level: "timeSensitive"}
	for _, bare := range []bool{false, true} {
		n.Bare = bare
		raw, _ := apnsPayload(n)
		if len(raw) > 4096 {
			t.Errorf("bare=%v: APNs payload %d bytes", bare, len(raw))
		}
		fcm, _ := json.Marshal(fcmMessage(n))
		if len(fcm) > 4096 {
			t.Errorf("bare=%v: FCM message %d bytes", bare, len(fcm))
		}
	}
}
