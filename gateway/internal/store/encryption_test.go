package store

import (
	"context"
	"testing"
	"time"
)

func TestMigrateEncryptionColumns(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	var v int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil || v < 7 {
		t.Fatalf("user_version = %d, %v", v, err)
	}
	dev, _, _ := s.CreateDevice(ctx, "ios", "tok", "")
	bot, _, err := s.CreateBot(ctx, dev, "b", "", "active")
	if err != nil || bot.Encrypted {
		t.Fatalf("bot = %+v, %v", bot, err)
	}
	yes := true
	if b, err := s.UpdateBot(ctx, dev.OwnerID, bot.ID, BotPatch{Encrypted: &yes}); err != nil || !b.Encrypted {
		t.Fatalf("update = %+v, %v", b, err)
	}
	b, _ := s.GetBot(ctx, dev.OwnerID, bot.ID)
	m, err := s.AddMessage(ctx, b, Message{Ciphertext: "abc", Level: "active"}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetMessage(ctx, dev.OwnerID, m.ID)
	if err != nil || got.Ciphertext != "abc" {
		t.Fatalf("got = %+v, %v", got, err)
	}
}
