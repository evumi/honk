package api

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/evumi/honk/gateway/internal/store"
)

type devView struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Platform string `json:"platform"`
	SeenAt   int64  `json:"seen_at"`
	Current  bool   `json:"current"`
}

// registerNamed registers a device with a name and returns its secret and id.
func (e *env) registerNamed(platform, name string) (string, string) {
	reg := must[struct {
		Device store.Device `json:"device"`
		Secret string       `json:"device_secret"`
	}](e.t, e.do("POST", "/v1/devices", "", map[string]string{"platform": platform, "push_token": "tok-" + name, "name": name}))
	return reg.Secret, reg.Device.ID
}

// pair joins joiner's group to creator's through the API.
func (e *env) pair(creator, joiner, linkID string) {
	e.t.Helper()
	must[map[string]any](e.t, e.do("POST", "/v1/links", creator, map[string]string{"link_id": linkID, "bundle": "YnVuZGxl"}))
	got := must[struct {
		Bundle string `json:"bundle"`
	}](e.t, e.do("POST", "/v1/links/claim", joiner, map[string]string{"link_id": linkID}))
	if got.Bundle != "YnVuZGxl" {
		e.t.Fatalf("bundle = %q", got.Bundle)
	}
}

const (
	linkA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	linkB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func TestPairingSharesBotsQueueAndPushes(t *testing.T) {
	e := setup(t)
	a, _ := e.registerNamed("ios", "iPhone")
	b, bID := e.registerNamed("android", "Pixel")
	must[map[string]any](t, e.do("POST", "/v1/bots", a, map[string]string{"name": "部署"}))
	bBot := must[struct {
		Token string `json:"token"`
	}](t, e.do("POST", "/v1/bots", b, map[string]string{"name": "备份"})) // the joiner has a bot too

	e.pair(a, b, linkA)

	for _, secret := range []string{a, b} {
		bots := must[[]store.Bot](t, e.do("GET", "/v1/bots", secret, nil))
		if len(bots) != 2 {
			t.Fatalf("%d bots", len(bots))
		}
	}
	devs := must[[]devView](t, e.do("GET", "/v1/devices", b, nil))
	if len(devs) != 2 || devs[0].Name != "iPhone" || devs[0].Current || devs[1].Name != "Pixel" || !devs[1].Current || devs[1].ID != bID || devs[1].Platform != "android" {
		t.Fatalf("devices = %+v", devs)
	}

	// A send pushes to both devices (both bots' tokens work).
	e.pusher.mu.Lock()
	e.pusher.sent = nil
	e.pusher.mu.Unlock()
	m := must[store.Message](t, e.do("POST", "/bot"+bBot.Token+"/sendMessage", "", map[string]string{"body": "hi"}))
	e.s.Wait()
	e.pusher.mu.Lock()
	tokens := map[string]bool{}
	for _, n := range e.pusher.sent {
		tokens[n.Token] = true
		if n.MessageID != m.ID {
			t.Errorf("push for %d", n.MessageID)
		}
	}
	e.pusher.mu.Unlock()
	if len(tokens) != 2 || !tokens["tok-iPhone"] || !tokens["tok-Pixel"] {
		t.Errorf("pushed to %v", tokens)
	}
	// The same for an edit and a delete.
	must[bool](t, e.do("POST", "/bot"+bBot.Token+"/editMessageData", "", map[string]any{"message_id": m.ID, "data": `{"a":1}`}))
	e.pusher.mu.Lock()
	editPushes := 0
	for _, n := range e.pusher.sent {
		if n.Kind == "edit" {
			editPushes++
		}
	}
	e.pusher.mu.Unlock()
	if editPushes != 2 {
		t.Errorf("edit pushed %d times", editPushes)
	}

	// Cursors and acks are per device.
	for _, secret := range []string{a, b} {
		page := must[struct {
			Messages []store.Message `json:"messages"`
			Cursor   int64           `json:"cursor"`
		}](t, e.do("GET", "/v1/sync?cursor=0", secret, nil))
		if len(page.Messages) != 2 {
			t.Fatalf("sync = %+v", page)
		}
		must[store.Message](t, e.do("GET", fmt.Sprintf("/v1/messages/%d", m.ID), secret, nil))
	}
	// a acks; b's watermark is its own.
	must[map[string]any](t, e.do("POST", "/v1/ack", a, map[string]int64{"up_to": m.ID}))
	ds, _ := e.s.store.ListDevices(context.Background(), ownerOf(e, a))
	if len(ds) != 2 || ds[0].AckedUpTo != m.ID || ds[1].AckedUpTo != 0 {
		t.Errorf("watermarks = %d, %d", ds[0].AckedUpTo, ds[1].AckedUpTo)
	}
}

func ownerOf(e *env, secret string) string {
	d, err := e.s.store.DeviceBySecret(context.Background(), secret)
	if err != nil {
		e.t.Fatal(err)
	}
	return d.OwnerID
}

func TestPairingErrors(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, ClaimBurst: 3, ClaimPerHour: 1, LinkTTL: 150 * time.Millisecond})
	a, _ := e.registerNamed("ios", "A")
	b, _ := e.registerNamed("android", "B")

	// Validation.
	for _, body := range []map[string]string{
		{"link_id": "short", "bundle": "YQ"},
		{"link_id": linkA, "bundle": "not base64url!"},
		{"link_id": linkA, "bundle": strings.Repeat("A", 16<<10+1)},
		{"link_id": linkA},
	} {
		if r := e.do("POST", "/v1/links", a, body); r.ErrorCode != 400 {
			t.Errorf("%v: %+v", body, r)
		}
	}
	if r := e.do("POST", "/v1/links", "", map[string]string{"link_id": linkA, "bundle": "YQ"}); r.ErrorCode != 401 {
		t.Errorf("no auth: %+v", r)
	}
	// 16 KB exactly is accepted.
	must[map[string]any](t, e.do("POST", "/v1/links", a, map[string]string{"link_id": linkA, "bundle": strings.Repeat("A", 16<<10)}))
	// A link id someone else holds is a conflict.
	if r := e.do("POST", "/v1/links", b, map[string]string{"link_id": linkA, "bundle": "YQ"}); r.ErrorCode != 409 {
		t.Errorf("duplicate link id: %+v", r)
	}

	// Expiry.
	time.Sleep(200 * time.Millisecond)
	if r := e.do("POST", "/v1/links/claim", b, map[string]string{"link_id": linkA}); r.ErrorCode != 404 {
		t.Errorf("expired: %+v", r)
	}
	// Reuse.
	e.s.opts.LinkTTL = time.Minute
	must[map[string]any](t, e.do("POST", "/v1/links", a, map[string]string{"link_id": linkB, "bundle": "YQ"}))
	must[map[string]any](t, e.do("POST", "/v1/links/claim", b, map[string]string{"link_id": linkB}))
	if r := e.do("POST", "/v1/links/claim", b, map[string]string{"link_id": linkB}); r.ErrorCode != 404 {
		t.Errorf("reused link: %+v", r)
	}
	// Those were the burst of 3 attempts; the next is limited, whatever it guesses.
	if r := e.do("POST", "/v1/links/claim", b, map[string]string{"link_id": linkB}); r.ErrorCode != 429 {
		t.Errorf("4th attempt: %+v", r)
	}
}

func TestClaimGuessingIsLimited(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, ClaimBurst: 5, ClaimPerHour: 1})
	b, _ := e.registerNamed("android", "B")
	codes := map[int]int{}
	for i := 0; i < 8; i++ {
		id := fmt.Sprintf("%043d", i)
		codes[e.do("POST", "/v1/links/claim", b, map[string]string{"link_id": id}).ErrorCode]++
	}
	if codes[404] != 5 || codes[429] != 3 {
		t.Errorf("results = %v, want five 404 then three 429", codes)
	}
}

func TestRemoveDeviceAndGroup(t *testing.T) {
	e := setup(t)
	a, aID := e.registerNamed("ios", "A")
	b, bID := e.registerNamed("android", "B")
	c, cID := e.registerNamed("android", "C") // another group
	tokenA := must[struct {
		Token string `json:"token"`
	}](t, e.do("POST", "/v1/bots", a, map[string]string{"name": "x"})).Token
	e.pair(a, b, linkA)

	// Not in my group: 404, and nothing happens.
	if r := e.do("DELETE", "/v1/devices/"+cID, a, nil); r.ErrorCode != 404 {
		t.Errorf("remove foreign device: %+v", r)
	}
	if r := e.do("GET", "/v1/devices/me", c, nil); !r.OK {
		t.Error("foreign device was removed")
	}
	// Remove a (which created the bot) from b: the group and its bot stay.
	must[bool](t, e.do("DELETE", "/v1/devices/"+aID, b, nil))
	if r := e.do("GET", "/v1/devices/me", a, nil); r.ErrorCode != 401 {
		t.Errorf("removed device still signs in: %+v", r)
	}
	if bots := must[[]store.Bot](t, e.do("GET", "/v1/bots", b, nil)); len(bots) != 1 {
		t.Errorf("bots = %+v", bots)
	}
	must[store.Message](t, e.do("POST", "/bot"+tokenA+"/sendMessage", "", map[string]string{"body": "still works"}))
	// Removing the last device deletes the group and its bots.
	must[bool](t, e.do("DELETE", "/v1/devices/"+bID, b, nil))
	if r := e.do("POST", "/bot"+tokenA+"/sendMessage", "", map[string]string{"body": "x"}); r.ErrorCode != 401 {
		t.Errorf("bot of a deleted group: %+v", r)
	}
	if d, bots, _ := e.s.store.Counts(context.Background()); d != 1 || bots != 0 {
		t.Errorf("devices %d bots %d", d, bots)
	}
}

func TestDeleteAllData(t *testing.T) {
	e := setup(t)
	a, _ := e.registerNamed("ios", "A")
	b, _ := e.registerNamed("android", "B")
	e.pair(a, b, linkA)
	// Without all, only this device leaves.
	must[bool](t, e.do("DELETE", "/v1/devices/me", b, nil))
	if r := e.do("GET", "/v1/devices/me", a, nil); !r.OK {
		t.Error("a was removed too")
	}
	b, _ = e.registerNamed("android", "B2")
	e.pair(a, b, linkB)
	must[bool](t, e.do("DELETE", "/v1/devices/me?all=true", b, nil))
	for _, s := range []string{a, b} {
		if r := e.do("GET", "/v1/devices/me", s, nil); r.ErrorCode != 401 {
			t.Errorf("device survived: %+v", r)
		}
	}
}

func TestBotLimitIsPerGroup(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, MaxBotsPerDevice: 2})
	a, _ := e.registerNamed("ios", "A")
	b, _ := e.registerNamed("android", "B")
	e.pair(a, b, linkA)
	must[map[string]any](t, e.do("POST", "/v1/bots", a, map[string]string{"name": "1"}))
	must[map[string]any](t, e.do("POST", "/v1/bots", b, map[string]string{"name": "2"}))
	if r := e.do("POST", "/v1/bots", a, map[string]string{"name": "3"}); r.ErrorCode != 400 {
		t.Errorf("third bot of the group: %+v", r)
	}
}

func TestMergeRefusedOverBotLimit(t *testing.T) {
	e := setupWith(t, Options{MessageTTL: time.Hour, SendRate: 100, SendBurst: 3, MaxBotsPerDevice: 2})
	a, _ := e.registerNamed("ios", "A")
	b, _ := e.registerNamed("android", "B")
	for _, s := range []string{a, b} {
		must[map[string]any](t, e.do("POST", "/v1/bots", s, map[string]string{"name": "1"}))
		must[map[string]any](t, e.do("POST", "/v1/bots", s, map[string]string{"name": "2"}))
	}
	must[map[string]any](t, e.do("POST", "/v1/links", a, map[string]string{"link_id": linkA, "bundle": "YQ"}))
	if r := e.do("POST", "/v1/links/claim", b, map[string]string{"link_id": linkA}); r.ErrorCode != 400 {
		t.Errorf("merge over the limit: %+v", r)
	}
}

func TestSeenAtAndInfo(t *testing.T) {
	e := setup(t)
	e.s.store.SetClock(func() time.Time { return time.Now().Add(-2 * time.Hour) })
	a, _ := e.registerNamed("ios", "A")
	e.s.store.SetClock(time.Now)
	d := must[store.Device](t, e.do("GET", "/v1/devices/me", a, nil))
	if d.Name != "A" || d.SeenAt < time.Now().Add(-time.Minute).UnixMilli() {
		t.Errorf("seen_at was not refreshed: %+v", d)
	}
	seen := d.SeenAt
	must[store.Device](t, e.do("GET", "/v1/devices/me", a, nil))
	if again := must[[]devView](t, e.do("GET", "/v1/devices", a, nil))[0].SeenAt; again != seen {
		t.Errorf("seen_at written again within the hour: %d != %d", again, seen)
	}
	info := must[struct {
		Features []string `json:"features"`
	}](t, e.do("GET", "/v1/info", "", nil))
	if len(info.Features) == 0 || info.Features[0] != "link" {
		t.Errorf("features = %v", info.Features)
	}
	if r := e.do("POST", "/v1/devices", "", map[string]string{"platform": "ios", "push_token": "t", "name": strings.Repeat("长", 65)}); r.ErrorCode != 400 {
		t.Errorf("long name: %+v", r)
	}
}

// A retry stops for the device that has acked, not for the group's others.
func TestPushStillWantedPerDevice(t *testing.T) {
	e := setup(t)
	a, aID := e.registerNamed("ios", "A")
	b, bID := e.registerNamed("android", "B")
	e.pair(a, b, linkA)
	tok := must[struct {
		Token string `json:"token"`
	}](t, e.do("POST", "/v1/bots", a, map[string]string{"name": "x"})).Token
	m := must[store.Message](t, e.do("POST", "/bot"+tok+"/sendMessage", "", map[string]string{"body": "x"}))
	must[map[string]any](t, e.do("POST", "/v1/ack", a, map[string]int64{"up_to": m.ID}))
	ctx := context.Background()
	if w, _ := e.s.store.PushStillWanted(ctx, aID, "tok-A", m.ID); w {
		t.Error("a acked, still wanted")
	}
	if w, _ := e.s.store.PushStillWanted(ctx, bID, "tok-B", m.ID); !w {
		t.Error("b has not acked, no longer wanted")
	}
}
