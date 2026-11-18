package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/evumi/honk/gateway/internal/client"
	"github.com/evumi/honk/gateway/internal/store"
)

// seal encrypts content the way a sender does (the CLI's own code).
func seal(t *testing.T, token string, content map[string]string, key []byte) string {
	t.Helper()
	plain, _ := json.Marshal(content)
	ct, err := client.Encrypt(key, client.BotID(token), plain)
	if err != nil {
		t.Fatal(err)
	}
	return ct
}

func TestEncryptedSendAndEdit(t *testing.T) {
	e := setup(t)
	secret, token := e.register("ios")
	key := bytes.Repeat([]byte{7}, 32)
	botID := client.BotID(token)

	// Ciphertext is accepted by any bot, without a body.
	ct := seal(t, token, map[string]string{"title": "T", "body": "secret body", "html": "<b>x</b>"}, key)
	sent := must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{
		"ciphertext": ct, "level": "passive", "group": "ci", "id": "c1",
	}))
	if sent.Ciphertext != ct || sent.Body != "" || sent.HTML != "" || sent.Level != "passive" || sent.Group != "ci" {
		t.Fatalf("sent = %+v", sent)
	}
	n := e.pusher.last(t)
	if !n.Bare || n.Title != "" || n.Body != "" || n.BotName != "" || n.BotID != botID || n.MessageID != sent.ID {
		t.Errorf("push leaks content: %+v", n)
	}
	got := must[store.Message](t, e.do("GET", fmt.Sprintf("/v1/messages/%d", sent.ID), secret, nil))
	plain, err := client.Decrypt(key, botID, got.Ciphertext)
	if err != nil || !strings.Contains(string(plain), "secret body") {
		t.Fatalf("fetched ciphertext = %q, %v", plain, err)
	}

	// Plaintext content next to the ciphertext, and malformed ciphertext, are refused.
	for name, p := range map[string]map[string]any{
		"plaintext body": {"ciphertext": ct, "body": "x"},
		"not base64":     {"ciphertext": "!!!"},
		"too short":      {"ciphertext": "AAAA"},
		"too long":       {"ciphertext": strings.Repeat("A", maxCiphertext+4)},
	} {
		if r := e.do("POST", "/bot"+token+"/sendMessage", "", p); r.OK || r.ErrorCode != 400 {
			t.Errorf("%s: %+v", name, r)
		}
	}
	dry := must[map[string]any](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{"ciphertext": ct, "dry_run": true}))
	if dry["dry_run"] != true {
		t.Errorf("dry run = %v", dry)
	}

	// An encrypted edit is queued as it is; the queued message is untouched.
	edit := seal(t, token, map[string]string{"data": `{"s":"ok"}`}, key)
	must[bool](t, e.do("POST", "/bot"+token+"/editMessageData", "", map[string]any{"id": "c1", "ciphertext": edit}))
	if n := e.pusher.last(t); n.Kind != "edit" || n.TargetID != sent.ID || !n.Bare || n.BotName != "" {
		t.Errorf("edit push = %+v", n)
	}
	page := must[struct {
		Messages []store.Message `json:"messages"`
	}](t, e.do("GET", "/v1/sync?cursor=0", secret, nil))
	if len(page.Messages) != 2 || page.Messages[0].Ciphertext != ct || page.Messages[1].Kind != "edit" || page.Messages[1].Ciphertext != edit {
		t.Fatalf("sync = %+v", page)
	}
	if r := e.do("POST", "/bot"+token+"/editMessageData", "", map[string]any{"id": "c1", "ciphertext": edit, "data": "x"}); r.OK {
		t.Error("an edit with both must fail")
	}
	if r := e.do("POST", "/bot"+token+"/deleteMessage", "", map[string]any{"id": "c1", "ciphertext": edit}); r.OK {
		t.Error("a delete with ciphertext must fail")
	}
}

func TestEncryptedBotRefusesPlaintext(t *testing.T) {
	e := setup(t)
	secret, token := e.register("android")
	botID := client.BotID(token)

	b := must[store.Bot](t, e.do("PATCH", "/v1/bots/"+botID, secret, map[string]any{"encrypted": true}))
	if !b.Encrypted {
		t.Fatalf("bot = %+v", b)
	}
	if got := must[store.Bot](t, e.do("GET", "/v1/bots/"+botID, secret, nil)); !got.Encrypted {
		t.Error("flag not stored")
	}

	r := e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{"title": "t", "body": "plain"})
	if r.OK || r.ErrorCode != 400 || !strings.Contains(r.Description, "end-to-end encrypted") {
		t.Fatalf("plaintext send = %+v", r)
	}
	if r := e.do("POST", "/bot"+token+"/editMessageData", "", map[string]any{"id": "x", "data": "plain"}); r.OK || r.ErrorCode != 400 {
		t.Errorf("plaintext edit = %+v", r)
	}
	ct := seal(t, token, map[string]string{"body": "hi"}, bytes.Repeat([]byte{1}, 32))
	sent := must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{"ciphertext": ct}))

	// A delete carries no content, but its push still names nothing.
	must[bool](t, e.do("POST", "/bot"+token+"/deleteMessage", "", map[string]any{"message_id": sent.ID}))
	if n := e.pusher.last(t); n.Kind != "delete" || !n.Bare || n.BotName != "" {
		t.Errorf("delete push = %+v", n)
	}

	// Switching it off allows plaintext again.
	must[store.Bot](t, e.do("PATCH", "/v1/bots/"+botID, secret, map[string]any{"encrypted": false}))
	must[store.Message](t, e.do("POST", "/bot"+token+"/sendMessage", "", map[string]any{"body": "plain again"}))
}
