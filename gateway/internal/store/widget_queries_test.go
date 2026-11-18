package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

// A v5 database gets the widget query columns; existing messages do not allow
// queries and bots have no webhook.
func TestMigrateWidgetQueries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "honk.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	d, _, _ := s.CreateDevice(ctx, "ios", "t", "")
	bot, _, _ := s.CreateBot(ctx, d, "a", "", "active")
	s.Close()
	db, _ := sql.Open("sqlite", "file:"+path)
	for _, q := range []string{
		`ALTER TABLE messages DROP COLUMN allow_queries`,
		`ALTER TABLE bots DROP COLUMN webhook_url`,
		`ALTER TABLE bots DROP COLUMN webhook_secret`,
		`ALTER TABLE bots DROP COLUMN encrypted`,
		`ALTER TABLE bots DROP COLUMN key_wrapped`,
		`ALTER TABLE messages DROP COLUMN ciphertext`,
		`ALTER TABLE devices DROP COLUMN resync`,
		`PRAGMA user_version = 5`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	b, err := s.GetBot(ctx, d.OwnerID, bot.ID)
	if err != nil || b.WebhookURL != "" {
		t.Fatalf("bot = %+v, %v", b, err)
	}
	if err := s.SetWebhook(ctx, b.Key, "https://x.example/h", "sec"); err != nil {
		t.Fatal(err)
	}
	m, err := s.AddMessage(ctx, b, Message{Body: "hi", AllowQueries: true}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetMessage(ctx, d.OwnerID, m.ID)
	if err != nil || !got.AllowQueries {
		t.Fatalf("message = %+v, %v", got, err)
	}
	if b, _ = s.GetBot(ctx, d.OwnerID, bot.ID); b.WebhookURL != "https://x.example/h" || b.WebhookSecret != "sec" {
		t.Errorf("webhook = %q %q", b.WebhookURL, b.WebhookSecret)
	}
}
