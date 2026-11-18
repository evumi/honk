package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func open(t *testing.T) (*Store, *time.Time) {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "honk.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	now := time.UnixMilli(1_800_000_000_000)
	s.SetClock(func() time.Time { return now })
	return s, &now
}

func TestDeviceAndBotTokens(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	d, secret, err := s.CreateDevice(ctx, "ios", "apns-token", "")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.DeviceBySecret(ctx, secret); err != nil || got.ID != d.ID {
		t.Fatalf("DeviceBySecret = %v, %v", got, err)
	}
	if _, err := s.DeviceBySecret(ctx, "wrong"); err != ErrNotFound {
		t.Fatalf("wrong secret: %v", err)
	}
	b, token, err := s.CreateBot(ctx, d, "部署", "", "active")
	if err != nil {
		t.Fatal(err)
	}
	gb, err := s.BotByToken(ctx, token)
	if err != nil || gb.ID != b.ID || gb.OwnerID != d.OwnerID {
		t.Fatalf("BotByToken = %+v %v", gb, err)
	}
	newToken, err := s.ResetBotToken(ctx, d.OwnerID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.BotByToken(ctx, token); err != ErrNotFound {
		t.Errorf("old token still works: %v", err)
	}
	if _, err := s.BotByToken(ctx, newToken); err != nil {
		t.Errorf("new token: %v", err)
	}
	// Another device cannot touch the bot.
	other, _, _ := s.CreateDevice(ctx, "android", "fcm", "")
	if _, err := s.GetBot(ctx, other.OwnerID, b.ID); err != ErrNotFound {
		t.Errorf("other device sees bot: %v", err)
	}
	if err := s.DeleteBot(ctx, other.OwnerID, b.ID); err != ErrNotFound {
		t.Errorf("other device deletes bot: %v", err)
	}
	// A gone token is only marked when it is still the current one.
	if err := s.MarkPushGone(ctx, d.ID, "stale"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.DeviceBySecret(ctx, secret); !got.PushOK {
		t.Error("stale token report marked the current token gone")
	}
}

func TestQueueCollapseEditDelete(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	d, _, _ := s.CreateDevice(ctx, "ios", "tok", "")
	b, _, _ := s.CreateBot(ctx, d, "部署", "", "active")
	ttl := time.Hour

	m1, err := s.AddMessage(ctx, b, Message{Body: "部署中", CollapseID: "dep-1", Data: `{"status":"部署中"}`}, ttl)
	if err != nil {
		t.Fatal(err)
	}
	m2, _ := s.AddMessage(ctx, b, Message{Body: "部署中（重试）", CollapseID: "dep-1"}, ttl)
	if _, err := s.GetMessage(ctx, d.OwnerID, m1.ID); err != ErrNotFound {
		t.Errorf("collapsed message still queued: %v", err)
	}

	e, err := s.EditData(ctx, b, Target{CollapseID: "dep-1"}, `{"status":"已上线"}`, ttl)
	if err != nil {
		t.Fatal(err)
	}
	if e.Kind != KindEdit || e.TargetID != m2.ID {
		t.Errorf("edit = %+v, want target %d", e, m2.ID)
	}
	if got, _ := s.GetMessage(ctx, d.OwnerID, m2.ID); got.Data != `{"status":"已上线"}` {
		t.Errorf("queued copy data = %q", got.Data)
	}

	del, err := s.DeleteMessage(ctx, b, Target{MessageID: m2.ID}, ttl)
	if err != nil {
		t.Fatal(err)
	}
	items, _ := s.Sync(ctx, d.OwnerID, 0, 100)
	if len(items) != 1 || items[0].ID != del.ID || items[0].Kind != KindDelete || items[0].CollapseID != "dep-1" {
		t.Fatalf("after delete, queue = %+v", items)
	}

	// An edit whose message was already cleaned up is still queued for the client.
	e2, err := s.EditData(ctx, b, Target{MessageID: 9999}, "x", ttl)
	if err != nil || e2.TargetID != 9999 {
		t.Errorf("edit of a delivered message = %+v, %v", e2, err)
	}
	// A bot cannot reach another bot's message by id.
	b2, _, _ := s.CreateBot(ctx, d, "other", "", "active")
	m3, _ := s.AddMessage(ctx, b, Message{Body: "x"}, ttl)
	if _, err := s.DeleteMessage(ctx, b2, Target{MessageID: m3.ID}, ttl); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetMessage(ctx, d.OwnerID, m3.ID); err != nil {
		t.Errorf("another bot deleted the message: %v", err)
	}
}

func TestSyncAckCleanup(t *testing.T) {
	s, now := open(t)
	ctx := context.Background()
	d, _, _ := s.CreateDevice(ctx, "android", "tok", "")
	b, _, _ := s.CreateBot(ctx, d, "bot", "", "active")
	var ids []int64
	for i := 0; i < 5; i++ {
		m, _ := s.AddMessage(ctx, b, Message{Body: "x"}, 2*time.Hour)
		ids = append(ids, m.ID)
	}
	page, _ := s.Sync(ctx, d.OwnerID, 0, 2)
	if len(page) != 2 || page[0].ID != ids[0] {
		t.Fatalf("first page = %+v", page)
	}
	page, _ = s.Sync(ctx, d.OwnerID, page[1].ID, 10)
	if len(page) != 3 {
		t.Fatalf("second page has %d", len(page))
	}
	if n, _ := s.Ack(ctx, d, ids[2]); n != 3 {
		t.Errorf("acked %d, want 3", n)
	}

	*now = now.Add(25 * time.Hour / 24) // 1h02m later: acked rows are old enough with a 1h keep
	if n, _ := s.Cleanup(ctx, time.Hour); n != 3 {
		t.Errorf("cleanup removed %d acked rows, want 3", n)
	}
	*now = now.Add(time.Hour) // past the 2h TTL
	if items, _ := s.Sync(ctx, d.OwnerID, 0, 10); len(items) != 0 {
		t.Errorf("expired rows still served: %d", len(items))
	}
	if n, _ := s.Cleanup(ctx, time.Hour); n != 2 {
		t.Errorf("cleanup removed %d expired rows, want 2", n)
	}
}

func TestReopenKeepsData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "honk.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	_, secret, _ := s.CreateDevice(context.Background(), "ios", "t", "")
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.DeviceBySecret(context.Background(), secret); err != nil {
		t.Fatalf("device lost after reopen: %v", err)
	}
}

// A v1 database (integer bot ids in tokens) gets short ids on upgrade; the old
// tokens and queued messages keep working.
func TestMigrateV1BotIDs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "honk.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	stmts := []string{
		schemaV1,
		"PRAGMA user_version = 1",
		`INSERT INTO devices (id, secret_hash, platform, push_token, created_at, updated_at) VALUES ('dev', x'00', 'ios', 'tok', 1, 1)`,
		`INSERT INTO bots (device_id, token_hash, name, created_at, updated_at) VALUES ('dev', x'01', 'a', 1, 1)`,
		`INSERT INTO bots (device_id, token_hash, name, created_at, updated_at) VALUES ('dev', x'02', 'b', 1, 1)`,
		`INSERT INTO messages (bot_id, device_id, kind, body, created_at, expires_at) VALUES (2, 'dev', 'message', 'hi', 1, 9999999999999)`,
	}
	for _, q := range stmts {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if _, err := db.Exec(`UPDATE bots SET token_hash = ? WHERE id = 2`, hash("2:old-secret")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE devices SET secret_hash = ?`, hash("dev-secret")); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	dev, err := s.DeviceBySecret(ctx, "dev-secret")
	if err != nil {
		t.Fatal(err)
	}
	bots, err := s.ListBots(ctx, dev.OwnerID)
	if err != nil || len(bots) != 2 {
		t.Fatalf("bots = %+v, %v", bots, err)
	}
	for _, b := range bots {
		if !ValidBotID(b.ID) {
			t.Errorf("bot %d got id %q", b.Key, b.ID)
		}
	}
	if bots[0].ID == bots[1].ID {
		t.Error("backfilled ids collide")
	}
	b, err := s.BotByToken(ctx, "2:old-secret")
	if err != nil || b.ID != bots[1].ID || b.Name != "b" {
		t.Fatalf("old token = %+v, %v", b, err)
	}
	items, _ := s.Sync(ctx, dev.OwnerID, 0, 10)
	if len(items) != 1 || items[0].BotID != b.ID {
		t.Errorf("queued message = %+v", items)
	}
	token, err := s.ResetBotToken(ctx, dev.OwnerID, b.ID)
	if err != nil || !strings.HasPrefix(token, b.ID+":") {
		t.Errorf("reset token = %q, %v", token, err)
	}
}

func TestValidBotID(t *testing.T) {
	for i := 0; i < 1000; i++ {
		if id := randomBotID(); !ValidBotID(id) {
			t.Fatalf("random id %q is not valid", id)
		}
	}
	for _, id := range []string{"", "4", "12345678", "aB3dE6g", "aB3dE6gH9", "aB3d-6gH", "0aB3dE6g"} {
		if ValidBotID(id) {
			t.Errorf("ValidBotID(%q) = true", id)
		}
	}
}

func TestRelaysAndMeta(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	if v, err := s.GetMeta(ctx, "k"); err != nil || v != "" {
		t.Fatalf("empty meta = %q, %v", v, err)
	}
	s.SetMeta(ctx, "k", "a")
	s.SetMeta(ctx, "k", "b")
	if v, _ := s.GetMeta(ctx, "k"); v != "b" {
		t.Errorf("meta = %q", v)
	}
	s.SetMeta(ctx, "k", "")
	if v, _ := s.GetMeta(ctx, "k"); v != "" {
		t.Errorf("meta after delete = %q", v)
	}

	r, key, err := s.CreateRelay(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.RelayByKey(ctx, key); err != nil || got.ID != r.ID || got.Blocked {
		t.Fatalf("RelayByKey = %+v, %v", got, err)
	}
	if _, err := s.RelayByKey(ctx, "nope"); err != ErrNotFound {
		t.Errorf("wrong key: %v", err)
	}
	if err := s.BlockRelay(ctx, r.ID, true); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.RelayByKey(ctx, key); !got.Blocked {
		t.Error("relay not blocked")
	}
	if err := s.BlockRelay(ctx, "missing", true); err != ErrNotFound {
		t.Errorf("block missing: %v", err)
	}
}

// A database from before the send options gets their columns on upgrade, with
// defaults, and its queued messages keep working.
func TestMigrateSendOptions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "honk.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		schemaV1,
		"PRAGMA user_version = 1",
		`INSERT INTO devices (id, secret_hash, platform, push_token, created_at, updated_at) VALUES ('dev', x'00', 'ios', 'tok', 1, 1)`,
		`INSERT INTO bots (device_id, token_hash, name, created_at, updated_at) VALUES ('dev', x'01', 'a', 1, 1)`,
		`INSERT INTO messages (bot_id, device_id, kind, body, created_at, expires_at) VALUES (1, 'dev', 'message', 'hi', 1, 9999999999999)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if _, err := db.Exec(`UPDATE devices SET secret_hash = ?`, hash("dev-secret")); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	dev, err := s.DeviceBySecret(ctx, "dev-secret")
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.Sync(ctx, dev.OwnerID, 0, 10)
	if err != nil || len(items) != 1 || items[0].Body != "hi" || items[0].OpenMode != "" || items[0].Image != "" || items[0].Silent {
		t.Fatalf("queued message = %+v, %v", items, err)
	}
	var v int
	s.db.QueryRow("PRAGMA user_version").Scan(&v)
	if v != 6 {
		t.Errorf("user_version = %d, want 6", v)
	}
}

func TestSendOptionsStored(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	d, _, _ := s.CreateDevice(ctx, "ios", "tok", "")
	b, _, _ := s.CreateBot(ctx, d, "部署", "", "active")
	m, err := s.AddMessage(ctx, b, Message{Body: "x", OpenMode: "url", Image: "https://a/i.png", ParseMode: "Markdown", Silent: true}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetMessage(ctx, d.OwnerID, m.ID)
	if err != nil || got.OpenMode != "url" || got.Image != "https://a/i.png" || got.ParseMode != "Markdown" || !got.Silent {
		t.Errorf("got = %+v, %v", got, err)
	}
	if got.ExpiresAt-got.CreatedAt != time.Minute.Milliseconds() {
		t.Errorf("expires %d after creation", got.ExpiresAt-got.CreatedAt)
	}
}
