package api

import (
	"bytes"
	"strings"
	"testing"

	"github.com/evumi/honk/gateway/internal/client"
	"github.com/evumi/honk/gateway/internal/store"
)

// A bot's key sealed with the group key is stored and returned to every device
// of the group, never to the sender, and cleared when encryption is turned off.
func TestKeyWrappedIsSharedWithTheGroup(t *testing.T) {
	e := setup(t)
	a, _ := e.registerNamed("ios", "iPhone")
	b, _ := e.registerNamed("android", "Pixel")
	bot := must[struct {
		Bot   store.Bot `json:"bot"`
		Token string    `json:"token"`
	}](t, e.do("POST", "/v1/bots", a, map[string]string{"name": "部署"}))
	e.pair(a, b, linkA)

	groupKey := bytes.Repeat([]byte{9}, 32)
	botKey := bytes.Repeat([]byte{5}, 32)
	wrapped, err := client.WrapBotKey(groupKey, botKey, bot.Bot.ID)
	if err != nil || len(wrapped) != 80 {
		t.Fatalf("wrapped = %q, %v", wrapped, err)
	}
	got := must[store.Bot](t, e.do("PATCH", "/v1/bots/"+bot.Bot.ID, a, map[string]any{"encrypted": true, "key_wrapped": wrapped}))
	if !got.Encrypted || got.KeyWrapped != wrapped {
		t.Fatalf("patched = %+v", got)
	}
	// The other device of the group reads it with the bot list and the bot.
	for _, path := range []string{"/v1/bots", "/v1/bots/" + bot.Bot.ID} {
		var seen store.Bot
		if path == "/v1/bots" {
			seen = must[[]store.Bot](t, e.do("GET", path, b, nil))[0]
		} else {
			seen = must[store.Bot](t, e.do("GET", path, b, nil))
		}
		if seen.KeyWrapped != wrapped {
			t.Errorf("%s: key_wrapped = %q", path, seen.KeyWrapped)
		}
		back, err := client.UnwrapBotKey(groupKey, seen.KeyWrapped, seen.ID)
		if err != nil || !bytes.Equal(back, botKey) {
			t.Errorf("%s: unwrap = %x, %v", path, back, err)
		}
	}
	// The sender never gets it.
	me := must[map[string]any](t, e.do("POST", "/bot"+bot.Token+"/getMe", "", nil))
	if _, has := me["key_wrapped"]; has {
		t.Errorf("getMe leaks key_wrapped: %v", me)
	}

	// Malformed values are refused.
	for _, bad := range []string{"AAAA", strings.Repeat("!", 80), wrapped + "AAAA"} {
		if r := e.do("PATCH", "/v1/bots/"+bot.Bot.ID, b, map[string]any{"key_wrapped": bad}); r.OK || r.ErrorCode != 400 {
			t.Errorf("%q accepted: %+v", bad, r)
		}
	}
	// Renaming leaves it alone; a reset replaces it.
	must[store.Bot](t, e.do("PATCH", "/v1/bots/"+bot.Bot.ID, b, map[string]any{"name": "x"}))
	if got := must[store.Bot](t, e.do("GET", "/v1/bots/"+bot.Bot.ID, a, nil)); got.KeyWrapped != wrapped {
		t.Errorf("rename dropped it: %+v", got)
	}
	w2, _ := client.WrapBotKey(groupKey, bytes.Repeat([]byte{6}, 32), bot.Bot.ID)
	must[store.Bot](t, e.do("PATCH", "/v1/bots/"+bot.Bot.ID, b, map[string]any{"key_wrapped": w2}))
	if got := must[store.Bot](t, e.do("GET", "/v1/bots/"+bot.Bot.ID, a, nil)); got.KeyWrapped != w2 {
		t.Errorf("reset not stored: %+v", got)
	}
	// Turning encryption off clears it, whatever the patch says.
	off := must[store.Bot](t, e.do("PATCH", "/v1/bots/"+bot.Bot.ID, a, map[string]any{"encrypted": false, "key_wrapped": w2}))
	if off.Encrypted || off.KeyWrapped != "" {
		t.Errorf("off = %+v", off)
	}
}

// Encrypted pushes are bare for every device of the group.
func TestEncryptedPushIsBareForEveryDevice(t *testing.T) {
	e := setup(t)
	a, _ := e.registerNamed("ios", "iPhone")
	b, _ := e.registerNamed("android", "Pixel")
	bot := must[struct {
		Bot   store.Bot `json:"bot"`
		Token string    `json:"token"`
	}](t, e.do("POST", "/v1/bots", a, map[string]string{"name": "部署"}))
	e.pair(a, b, linkA)
	e.pusher.mu.Lock()
	e.pusher.sent = nil
	e.pusher.mu.Unlock()

	ct := seal(t, bot.Token, map[string]string{"body": "secret"}, bytes.Repeat([]byte{3}, 32))
	must[store.Message](t, e.do("POST", "/bot"+bot.Token+"/sendMessage", "", map[string]any{"ciphertext": ct, "silent": true}))
	e.pusher.mu.Lock()
	defer e.pusher.mu.Unlock()
	if len(e.pusher.sent) != 2 {
		t.Fatalf("pushed to %d devices", len(e.pusher.sent))
	}
	for _, n := range e.pusher.sent {
		if !n.Bare || n.Title != "" || n.Body != "" || n.BotName != "" || n.Group != "" || !n.Quiet {
			t.Errorf("push = %+v", n)
		}
	}
}
