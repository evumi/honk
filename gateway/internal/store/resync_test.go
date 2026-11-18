package store

import (
	"context"
	"testing"
	"time"
)

// Cleanup must not delete merged messages just because the old devices'
// watermarks are above their ids.
func TestClaimKeepsMovedMessagesForOldDevices(t *testing.T) {
	s, now := open(t)
	ctx := context.Background()
	a, _, _ := s.CreateDevice(ctx, "ios", "ta", "iPhone")
	b, _, _ := s.CreateDevice(ctx, "android", "tb", "Pixel")
	botA, _, _ := s.CreateBot(ctx, a, "A", "", "active")
	botB, _, _ := s.CreateBot(ctx, b, "B", "", "active")
	low, _ := s.AddMessage(ctx, botB, Message{Body: "on b"}, 72*time.Hour)
	high, _ := s.AddMessage(ctx, botA, Message{Body: "on a"}, 72*time.Hour)
	s.Ack(ctx, a, high.ID)
	if a, _ = s.deviceByID(ctx, a.ID); a.Resync {
		t.Fatal("resync before any merge")
	}

	if _, err := s.ClaimLinkFor(t, a, b); err != nil {
		t.Fatal(err)
	}
	a2, _ := s.deviceByID(ctx, a.ID)
	if !a2.Resync || a2.AckedUpTo != low.ID-1 {
		t.Errorf("creator device after merge: resync=%v acked=%d, want true and %d", a2.Resync, a2.AckedUpTo, low.ID-1)
	}
	*now = now.Add(48 * time.Hour)
	if n, _ := s.Cleanup(ctx, time.Hour); n != 0 {
		t.Errorf("cleanup removed %d moved messages", n)
	}
	// Once both devices have really acked, they go.
	s.Ack(ctx, a2, high.ID)
	b2, _ := s.deviceByID(ctx, b.ID)
	s.Ack(ctx, b2, high.ID)
	if n, _ := s.Cleanup(ctx, time.Hour); n != 2 {
		t.Errorf("cleanup removed %d after acks, want 2", n)
	}
}
