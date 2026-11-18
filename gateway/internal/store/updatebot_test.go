package store

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

func TestUpdateBotWritesOnlyPatchedColumns(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	dev, _, _ := s.CreateDevice(ctx, "ios", "tok", "")
	bot, _, err := s.CreateBot(ctx, dev, "b", "", "active")
	if err != nil {
		t.Fatal(err)
	}
	yes, no := true, false
	key := "wrapped"
	if _, err := s.UpdateBot(ctx, dev.OwnerID, bot.ID, BotPatch{KeyWrapped: &key}); err != nil {
		t.Fatal(err)
	}
	if b, _ := s.GetBot(ctx, dev.OwnerID, bot.ID); b.KeyWrapped != "" {
		t.Errorf("key kept without encryption: %+v", b)
	}
	if b, err := s.UpdateBot(ctx, dev.OwnerID, bot.ID, BotPatch{Encrypted: &yes, KeyWrapped: &key}); err != nil || !b.Encrypted || b.KeyWrapped != key {
		t.Fatalf("enable = %+v, %v", b, err)
	}

	// Many concurrent patches of other fields never touch encrypted / key_wrapped.
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n := fmt.Sprint("n", i)
			if _, err := s.UpdateBot(ctx, dev.OwnerID, bot.ID, BotPatch{Name: &n}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	b, _ := s.GetBot(ctx, dev.OwnerID, bot.ID)
	if !b.Encrypted || b.KeyWrapped != key || b.Name == "b" {
		t.Errorf("after name patches: %+v", b)
	}

	if b, _ := s.UpdateBot(ctx, dev.OwnerID, bot.ID, BotPatch{Encrypted: &no}); b.Encrypted || b.KeyWrapped != "" {
		t.Errorf("disable = %+v", b)
	}
	if _, err := s.UpdateBot(ctx, dev.OwnerID, "nope", BotPatch{Name: &key}); err != ErrNotFound {
		t.Errorf("missing bot: %v", err)
	}
}
