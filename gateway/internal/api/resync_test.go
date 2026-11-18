package api

import (
	"fmt"
	"testing"

	"github.com/evumi/honk/gateway/internal/store"
)

type syncView struct {
	Messages []store.Message `json:"messages"`
	Cursor   int64           `json:"cursor"`
	Reset    bool            `json:"reset"`
}

func (e *env) syncFrom(secret string, cursor int64) (syncView, map[string]any) {
	e.t.Helper()
	path := fmt.Sprintf("/v1/sync?cursor=%d", cursor)
	raw := must[map[string]any](e.t, e.do("GET", path, secret, nil))
	return must[syncView](e.t, e.do("GET", path, secret, nil)), raw
}

// Pairing merges the joiner's queue into the creator's group. The creator's
// devices have cursors past those ids, so /v1/sync tells them to start again.
func TestSyncResetAfterMergedQueue(t *testing.T) {
	e := setup(t)
	a, _ := e.registerNamed("ios", "iPhone")
	b, _ := e.registerNamed("android", "Pixel")
	aBot := must[struct {
		Token string `json:"token"`
	}](t, e.do("POST", "/v1/bots", a, map[string]string{"name": "A"}))
	bBot := must[struct {
		Token string `json:"token"`
	}](t, e.do("POST", "/v1/bots", b, map[string]string{"name": "B"}))

	// b's queue gets a message first (a low id), then a's gets one and a syncs past both.
	must[store.Message](t, e.do("POST", "/bot"+bBot.Token+"/sendMessage", "", map[string]string{"body": "on b"}))
	must[store.Message](t, e.do("POST", "/bot"+aBot.Token+"/sendMessage", "", map[string]string{"body": "on a"}))
	got, raw := e.syncFrom(a, 0)
	if len(got.Messages) != 1 || got.Reset {
		t.Fatalf("before pairing: %+v", got)
	}
	if _, has := raw["reset"]; has {
		t.Error("reset present without a merge")
	}
	cursorA := got.Cursor
	must[map[string]any](t, e.do("POST", "/v1/ack", a, map[string]int64{"up_to": cursorA}))

	e.pair(a, b, linkA)

	// a's old cursor would skip b's message: it is told to reset, until it syncs from 0.
	if got, _ = e.syncFrom(a, cursorA); !got.Reset {
		t.Fatalf("no reset after merge: %+v", got)
	}
	if got, _ = e.syncFrom(a, cursorA); !got.Reset {
		t.Error("reset must repeat until the device syncs from 0")
	}
	got, raw = e.syncFrom(a, 0)
	if len(got.Messages) != 2 || got.Reset {
		t.Fatalf("sync from 0: %+v", got)
	}
	if _, has := raw["reset"]; has {
		t.Error("reset present on the sync that cleared it")
	}
	if got, _ = e.syncFrom(a, cursorA); got.Reset {
		t.Error("reset not cleared by the sync from 0")
	}

	// The claimer's devices have not seen a's queue either.
	if got, _ = e.syncFrom(b, 9999); !got.Reset {
		t.Error("claimer not told to reset")
	}
}
