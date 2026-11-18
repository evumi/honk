package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

// Two devices of a group read the queue at their own pace, and the queue only
// shrinks once the slowest one has acked.
func TestGroupCursorsAckAndCleanup(t *testing.T) {
	s, now := open(t)
	ctx := context.Background()
	a, _, _ := s.CreateDevice(ctx, "ios", "ta", "iPhone")
	b, _, _ := s.CreateDevice(ctx, "android", "tb", "Pixel")
	bot, _, _ := s.CreateBot(ctx, a, "bot", "", "active")
	if _, err := s.ClaimLinkFor(t, a, b); err != nil {
		t.Fatal(err)
	}
	b, _ = s.deviceByID(ctx, b.ID)
	var ids []int64
	for i := 0; i < 3; i++ {
		m, _ := s.AddMessage(ctx, bot, Message{Body: "x"}, 48*time.Hour)
		ids = append(ids, m.ID)
	}
	for _, d := range []Device{a, b} {
		if items, _ := s.Sync(ctx, d.OwnerID, 0, 10); len(items) != 3 {
			t.Fatalf("device %s sees %d items", d.ID, len(items))
		}
	}
	// Device a acks everything; b only the first.
	if n, _ := s.Ack(ctx, a, ids[2]); n != 3 {
		t.Errorf("a acked %d", n)
	}
	if n, _ := s.Ack(ctx, b, ids[0]); n != 1 {
		t.Errorf("b acked %d", n)
	}
	// A lower ack never lowers the watermark, a huge one is capped.
	s.Ack(ctx, a, 1)
	if got, _ := s.deviceByID(ctx, a.ID); got.AckedUpTo != ids[2] {
		t.Errorf("a watermark = %d", got.AckedUpTo)
	}
	s.Ack(ctx, b, 1<<60)
	if got, _ := s.deviceByID(ctx, b.ID); got.AckedUpTo != ids[2] {
		t.Errorf("b watermark after huge ack = %d, want the last id %d", got.AckedUpTo, ids[2])
	}
	s.db.Exec(`UPDATE devices SET acked_up_to = ? WHERE id = ?`, ids[0], b.ID) // as if b had acked only the first

	*now = now.Add(2 * time.Hour)
	if n, _ := s.Cleanup(ctx, time.Hour); n != 1 {
		t.Fatalf("cleanup removed %d, want only the item both devices acked", n)
	}
	if items, _ := s.Sync(ctx, a.OwnerID, 0, 10); len(items) != 2 {
		t.Errorf("%d items left, want 2", len(items))
	}
	s.Ack(ctx, b, ids[2])
	if n, _ := s.Cleanup(ctx, time.Hour); n != 2 {
		t.Errorf("cleanup removed %d, want 2", n)
	}
	// Not old enough: kept even when everyone acked.
	m, _ := s.AddMessage(ctx, bot, Message{Body: "new"}, 48*time.Hour)
	s.Ack(ctx, a, m.ID)
	s.Ack(ctx, b, m.ID)
	if n, _ := s.Cleanup(ctx, time.Hour); n != 0 {
		t.Errorf("cleanup removed %d fresh items", n)
	}
}

func (s *Store) deviceByID(ctx context.Context, id string) (Device, error) {
	return scanDevice(s.db.QueryRowContext(ctx, `SELECT `+devCols+` FROM devices WHERE id = ?`, id))
}

// ClaimLinkFor makes a link from creator's group and claims it as joiner.
func (s *Store) ClaimLinkFor(t *testing.T, creator, joiner Device) (string, error) {
	t.Helper()
	ctx := context.Background()
	id := "link-" + creator.ID + joiner.ID
	if err := s.CreateLink(ctx, creator.OwnerID, id, "YnVuZGxl", 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	return s.ClaimLink(ctx, id, joiner.ID, 0)
}

func TestMergeGroupsWithBots(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	a, _, _ := s.CreateDevice(ctx, "ios", "ta", "iPhone")
	b, _, _ := s.CreateDevice(ctx, "android", "tb", "Pixel")
	botA, tokA, _ := s.CreateBot(ctx, a, "A", "", "active")
	botB, tokB, _ := s.CreateBot(ctx, b, "B", "", "active")
	mB, _ := s.AddMessage(ctx, botB, Message{Body: "queued on b"}, time.Hour)
	s.Ack(ctx, b, mB.ID)

	oldOwner := b.OwnerID
	bundle, err := s.ClaimLinkFor(t, a, b)
	if err != nil || bundle != "YnVuZGxl" {
		t.Fatalf("claim = %q, %v", bundle, err)
	}
	bots, _ := s.ListBots(ctx, a.OwnerID)
	if len(bots) != 2 {
		t.Fatalf("merged group has %d bots", len(bots))
	}
	if got, _ := s.deviceByID(ctx, b.ID); got.OwnerID != a.OwnerID || got.AckedUpTo != 0 {
		t.Errorf("claimer = %+v", got)
	}
	ds, _ := s.ListDevices(ctx, a.OwnerID)
	if len(ds) != 2 {
		t.Errorf("%d devices in the group", len(ds))
	}
	if items, _ := s.Sync(ctx, a.OwnerID, 0, 10); len(items) != 1 || items[0].BotID != botB.ID {
		t.Errorf("queue after merge = %+v", items)
	}
	if _, err := s.ListBots(ctx, oldOwner); err != nil {
		t.Error(err)
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM owners WHERE id = ?`, oldOwner).Scan(&n)
	if n != 0 {
		t.Error("old group kept")
	}
	// Both tokens still work and push to both devices.
	for _, tok := range []string{tokA, tokB} {
		bot, err := s.BotByToken(ctx, tok)
		if err != nil || bot.OwnerID != a.OwnerID {
			t.Fatalf("token %s: %+v %v", tok, bot, err)
		}
	}
	if pd, _ := s.PushDevices(ctx, a.OwnerID); len(pd) != 2 {
		t.Errorf("%d push devices", len(pd))
	}
	_ = botA
}

func TestLinkExpiryReuseAndLimits(t *testing.T) {
	s, now := open(t)
	ctx := context.Background()
	a, _, _ := s.CreateDevice(ctx, "ios", "ta", "")
	b, _, _ := s.CreateDevice(ctx, "android", "tb", "")
	c, _, _ := s.CreateDevice(ctx, "android", "tc", "")

	if err := s.CreateLink(ctx, a.OwnerID, "link-one-aaaaaaaaaa", "b1", 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	// One active link per group: a new one replaces the old.
	if err := s.CreateLink(ctx, a.OwnerID, "link-two-aaaaaaaaaa", "b2", 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimLink(ctx, "link-one-aaaaaaaaaa", b.ID, 0); err != ErrNotFound {
		t.Errorf("replaced link: %v", err)
	}
	if _, err := s.ClaimLink(ctx, "link-two-aaaaaaaaaa", b.ID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimLink(ctx, "link-two-aaaaaaaaaa", c.ID, 0); err != ErrNotFound {
		t.Errorf("reused link: %v", err)
	}
	// Expiry.
	s.CreateLink(ctx, a.OwnerID, "link-three-aaaaaaaaa", "b3", 10*time.Minute)
	*now = now.Add(11 * time.Minute)
	if _, err := s.ClaimLink(ctx, "link-three-aaaaaaaaa", c.ID, 0); err != ErrNotFound {
		t.Errorf("expired link: %v", err)
	}
	// Bot limit on merge.
	s.CreateBot(ctx, a, "1", "", "active")
	s.CreateBot(ctx, c, "2", "", "active")
	s.CreateLink(ctx, a.OwnerID, "link-four-aaaaaaaaaa", "b4", 10*time.Minute)
	if _, err := s.ClaimLink(ctx, "link-four-aaaaaaaaaa", c.ID, 1); err != ErrTooManyBots {
		t.Errorf("over the bot limit: %v", err)
	}
	// A refused merge rolls back, so the link is not used up.
	if _, err := s.ClaimLink(ctx, "link-four-aaaaaaaaaa", c.ID, 2); err != nil {
		t.Errorf("link lost after a refused merge: %v", err)
	}
}

func TestRemoveDevices(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	a, _, _ := s.CreateDevice(ctx, "ios", "ta", "")
	b, _, _ := s.CreateDevice(ctx, "android", "tb", "")
	bot, tok, _ := s.CreateBot(ctx, a, "bot", "", "active") // created by a
	s.AddMessage(ctx, bot, Message{Body: "x"}, time.Hour)
	s.ClaimLinkFor(t, a, b)

	// Removing the device that created the bot keeps the group's bots.
	gone, err := s.DeleteDevice(ctx, a.ID)
	if err != nil || gone {
		t.Fatalf("delete a = %v, %v", gone, err)
	}
	if bots, _ := s.ListBots(ctx, a.OwnerID); len(bots) != 1 {
		t.Fatalf("bots after removing the creator: %d", len(bots))
	}
	if items, _ := s.Sync(ctx, a.OwnerID, 0, 10); len(items) != 1 {
		t.Errorf("queue after removing the creator: %d", len(items))
	}
	if _, err := s.BotByToken(ctx, tok); err != nil {
		t.Errorf("token after removing the creator: %v", err)
	}
	if _, err := s.DeleteDevice(ctx, a.ID); err != ErrNotFound {
		t.Errorf("delete twice: %v", err)
	}
	// The last device takes the group with it.
	gone, err = s.DeleteDevice(ctx, b.ID)
	if err != nil || !gone {
		t.Fatalf("delete last = %v, %v", gone, err)
	}
	for _, q := range []string{`SELECT COUNT(*) FROM owners`, `SELECT COUNT(*) FROM bots`, `SELECT COUNT(*) FROM messages`, `SELECT COUNT(*) FROM devices`} {
		var n int
		s.db.QueryRow(q).Scan(&n)
		if n != 0 {
			t.Errorf("%s = %d", q, n)
		}
	}
}

func TestDeleteOwner(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	a, _, _ := s.CreateDevice(ctx, "ios", "ta", "")
	b, _, _ := s.CreateDevice(ctx, "android", "tb", "")
	other, _, _ := s.CreateDevice(ctx, "android", "to", "")
	s.CreateBot(ctx, a, "bot", "", "active")
	s.CreateBot(ctx, other, "keep", "", "active")
	s.ClaimLinkFor(t, a, b)
	if err := s.DeleteOwner(ctx, a.OwnerID); err != nil {
		t.Fatal(err)
	}
	if d, bots, _ := s.Counts(ctx); d != 1 || bots != 1 {
		t.Errorf("devices %d bots %d left, want 1 and 1", d, bots)
	}
}

func TestGCDevices(t *testing.T) {
	s, now := open(t)
	ctx := context.Background()
	idle := 90 * 24 * time.Hour
	gone, _, _ := s.CreateDevice(ctx, "ios", "t1", "")     // dead token, never seen again
	live, _, _ := s.CreateDevice(ctx, "ios", "t2", "")     // token fine
	back, _, _ := s.CreateDevice(ctx, "android", "t3", "") // dead token, but seen lately
	solo, _, _ := s.CreateDevice(ctx, "android", "t4", "") // dead token, shares a group
	mate, _, _ := s.CreateDevice(ctx, "android", "t5", "")
	botGone, _, _ := s.CreateBot(ctx, gone, "g", "", "active")
	botSolo, _, _ := s.CreateBot(ctx, solo, "s", "", "active")
	s.ClaimLinkFor(t, mate, solo) // solo joins mate's group
	for _, d := range []Device{gone, back, solo} {
		s.MarkPushGone(ctx, d.ID, d.PushToken)
	}
	*now = now.Add(idle - time.Hour)
	s.TouchDevice(ctx, back.ID)
	*now = now.Add(2 * time.Hour)
	n, err := s.GCDevices(ctx, idle)
	if err != nil || n != 2 {
		t.Fatalf("gc = %d, %v", n, err)
	}
	if _, err := s.deviceByID(ctx, gone.ID); err != ErrNotFound {
		t.Errorf("dead device kept: %v", err)
	}
	if _, err := s.GetBot(ctx, gone.OwnerID, botGone.ID); err != ErrNotFound {
		t.Errorf("bot of the collected device: %v", err)
	}
	// solo left a group that still has mate: the bot stays with the group.
	if _, err := s.GetBot(ctx, mate.OwnerID, botSolo.ID); err != nil {
		t.Errorf("bot of the group: %v", err)
	}
	if ds, _ := s.ListDevices(ctx, live.OwnerID); len(ds) != 1 {
		t.Error("live device collected")
	}
	if ds, _ := s.ListDevices(ctx, back.OwnerID); len(ds) != 1 {
		t.Error("recently seen device collected")
	}
}

// A v3 database: each device becomes a group; the per-message acks become the
// device's watermark; queued messages and bots follow their device.
func TestMigrateV3Groups(t *testing.T) {
	path := filepath.Join(t.TempDir(), "honk.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	tx, _ := db.BeginTx(ctx, nil)
	for _, f := range []func(context.Context, *sql.Tx) error{
		func(ctx context.Context, tx *sql.Tx) error { _, err := tx.ExecContext(ctx, schemaV1); return err },
		migrateV2, migrateV3,
	} {
		if err := f(ctx, tx); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		`INSERT INTO devices (id, secret_hash, platform, push_token, created_at, updated_at) VALUES ('d1', x'00', 'ios', 't', 1, 5)`,
		`INSERT INTO devices (id, secret_hash, platform, push_token, created_at, updated_at) VALUES ('d2', x'01', 'android', 't', 1, 6)`,
		`INSERT INTO bots (public_id, device_id, token_hash, name, created_at, updated_at) VALUES ('Abcdefgh', 'd1', x'01', 'n', 1, 1)`,
		`INSERT INTO bots (public_id, device_id, token_hash, name, created_at, updated_at) VALUES ('Bbcdefgh', 'd2', x'02', 'm', 1, 1)`,
		// d1: items 1, 2 acked, 3 not, 4 acked (the watermark stops before the gap).
		`INSERT INTO messages (bot_id, device_id, kind, created_at, expires_at, acked_at) VALUES (1, 'd1', 'message', 1, 9, 5)`,
		`INSERT INTO messages (bot_id, device_id, kind, created_at, expires_at, acked_at) VALUES (1, 'd1', 'message', 1, 9, 5)`,
		`INSERT INTO messages (bot_id, device_id, kind, created_at, expires_at) VALUES (1, 'd1', 'message', 1, 9)`,
		`INSERT INTO messages (bot_id, device_id, kind, created_at, expires_at, acked_at) VALUES (1, 'd1', 'message', 1, 9, 5)`,
		// d2: everything acked.
		`INSERT INTO messages (bot_id, device_id, kind, created_at, expires_at, acked_at) VALUES (2, 'd2', 'message', 1, 9, 5)`,
		`PRAGMA user_version = 3`,
	} {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	d1, err := s.deviceByID(ctx, "d1")
	if err != nil {
		t.Fatal(err)
	}
	d2, _ := s.deviceByID(ctx, "d2")
	if d1.OwnerID == "" || d1.OwnerID == d2.OwnerID {
		t.Errorf("owners %q and %q", d1.OwnerID, d2.OwnerID)
	}
	if d1.AckedUpTo != 2 || d2.AckedUpTo != 5 || d1.SeenAt != 5 {
		t.Errorf("d1 = %+v d2 = %+v", d1, d2)
	}
	if bots, _ := s.ListBots(ctx, d1.OwnerID); len(bots) != 1 || bots[0].ID != "Abcdefgh" {
		t.Errorf("d1 bots = %+v", bots)
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE owner_id = ?`, d1.OwnerID).Scan(&n)
	if n != 4 {
		t.Errorf("d1 has %d messages", n)
	}
	var v int
	s.db.QueryRow(`PRAGMA user_version`).Scan(&v)
	if v != 7 {
		t.Errorf("user_version = %d", v)
	}
}
