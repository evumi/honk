package api

import (
	"encoding/json"
	"testing"
	"time"
)

func TestHubPushPrunesAndCaps(t *testing.T) {
	h := newQueryHub()
	h.push("b", 1, json.RawMessage(`1`), time.Millisecond)
	time.Sleep(5 * time.Millisecond)
	h.push("b", 2, json.RawMessage(`2`), time.Hour)
	if n := len(h.queues["b"].updates); n != 1 {
		t.Fatalf("expired update kept: %d", n)
	}
	for i := int64(3); i < 3+3*maxQueuedUpdates; i++ {
		h.push("b", i, json.RawMessage(`0`), time.Hour)
	}
	u := h.queues["b"].updates
	if len(u) != maxQueuedUpdates || u[len(u)-1].id != 2+3*maxQueuedUpdates {
		t.Fatalf("len %d last %d", len(u), u[len(u)-1].id)
	}
	if u[0].id != u[len(u)-1].id-maxQueuedUpdates+1 {
		t.Errorf("oldest not dropped first: %d", u[0].id)
	}
}
