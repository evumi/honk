package store

import (
	"context"
	"testing"
)

func pushIDs(t *testing.T, s *Store, owner string) []string {
	t.Helper()
	ds, err := s.PushDevices(context.Background(), owner)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, d := range ds {
		ids = append(ids, d.ID)
	}
	return ids
}

func TestReinstalledDeviceSupersedesOldRowWithSameToken(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	old, _, _ := s.CreateDevice(ctx, "ios", "same-token", "")
	other, _, _ := s.CreateDevice(ctx, "android", "same-token", "") // another platform: unrelated
	if ids := pushIDs(t, s, other.OwnerID); len(ids) != 1 {
		t.Fatalf("android device lost its push: %v", ids)
	}

	// Reinstall: the same token registers as a new device in its own group.
	fresh, _, _ := s.CreateDevice(ctx, "ios", "same-token", "")
	if ids := pushIDs(t, s, old.OwnerID); len(ids) != 0 {
		t.Errorf("old row still pushed to: %v", ids)
	}
	// It pairs into the old group: only one device of the group is pushed to.
	if err := s.CreateLink(ctx, old.OwnerID, "link-dup-aaaaaaaaaaaa", "bundle", 600e9); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimLink(ctx, "link-dup-aaaaaaaaaaaa", fresh.ID, 0); err != nil {
		t.Fatal(err)
	}
	if ids := pushIDs(t, s, old.OwnerID); len(ids) != 1 || ids[0] != fresh.ID {
		t.Errorf("push devices = %v, want only %s", ids, fresh.ID)
	}

	// A token update that lands on another device's token supersedes it too.
	third, _, _ := s.CreateDevice(ctx, "ios", "t3", "")
	if err := s.UpdateDevice(ctx, third.ID, "same-token", ""); err != nil {
		t.Fatal(err)
	}
	if ids := pushIDs(t, s, old.OwnerID); len(ids) != 0 {
		t.Errorf("after token update: %v", ids)
	}
	if ids := pushIDs(t, s, third.OwnerID); len(ids) != 1 {
		t.Errorf("updated device: %v", ids)
	}
}

func TestPushDevicesDedupesByToken(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	a, _, _ := s.CreateDevice(ctx, "ios", "x", "")
	b, _, _ := s.CreateDevice(ctx, "ios", "y", "")
	if err := s.CreateLink(ctx, a.OwnerID, "link-ddp-aaaaaaaaaaaa", "bundle", 600e9); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimLink(ctx, "link-ddp-aaaaaaaaaaaa", b.ID, 0); err != nil {
		t.Fatal(err)
	}
	// Force two live rows with one token, as a database from before the fix may hold.
	if _, err := s.db.ExecContext(ctx, `UPDATE devices SET push_token = 'x' WHERE id = ?`, b.ID); err != nil {
		t.Fatal(err)
	}
	if ids := pushIDs(t, s, a.OwnerID); len(ids) != 1 || ids[0] != b.ID {
		t.Errorf("ids = %v, want only the newer %s", ids, b.ID)
	}
}
