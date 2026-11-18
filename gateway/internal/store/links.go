package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Link errors.
var (
	// ErrConflict: a link with this id already exists.
	ErrConflict = errors.New("conflict")
	// ErrTooManyBots: merging the two groups would exceed the bot limit.
	ErrTooManyBots = errors.New("too many bots")
)

// CreateLink stores the bundle a paired device will fetch with the link id.
// Only the hash of the id is kept. A group has one active link: an earlier
// one is dropped, and so are expired ones.
func (s *Store) CreateLink(ctx context.Context, ownerID, linkID, bundle string, ttl time.Duration) error {
	now := s.now()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM links WHERE owner_id = ? OR expires_at <= ?`, ownerID, now.UnixMilli()); err != nil {
		return err
	}
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM links WHERE link_hash = ?`, hash(linkID)).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO links (link_hash, owner_id, bundle, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		hash(linkID), ownerID, bundle, now.UnixMilli(), now.Add(ttl).UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

// ClaimLink uses up a link: the claiming device's whole group (devices, bots
// and queued messages) joins the group that created it, and the bundle is
// returned. An unknown, expired or used link is ErrNotFound. With maxBots > 0
// the merged group may not have more bots than that.
func (s *Store) ClaimLink(ctx context.Context, linkID, deviceID string, maxBots int) (string, error) {
	now := s.ms()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var owner, bundle string
	var expires int64
	err = tx.QueryRowContext(ctx, `SELECT owner_id, bundle, expires_at FROM links WHERE link_hash = ?`, hash(linkID)).Scan(&owner, &bundle, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM links WHERE link_hash = ?`, hash(linkID)); err != nil {
		return "", err
	}
	if expires <= now {
		// Commit the delete: an expired link is gone for good.
		if err := tx.Commit(); err != nil {
			return "", err
		}
		return "", ErrNotFound
	}
	var mine string
	if err := tx.QueryRowContext(ctx, `SELECT owner_id FROM devices WHERE id = ?`, deviceID).Scan(&mine); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if mine != owner {
		if maxBots > 0 {
			var n int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM bots WHERE owner_id IN (?, ?)`, owner, mine).Scan(&n); err != nil {
				return "", err
			}
			if n > maxBots {
				return "", ErrTooManyBots
			}
		}
		// The claimer's watermark counted messages of its old group; start
		// again so nothing of the new group is taken as stored.
		steps := []struct {
			q    string
			args []any
		}{
			{`UPDATE devices SET acked_up_to = 0, owner_id = ? WHERE owner_id = ?`, []any{owner, mine}},
			{`UPDATE bots SET owner_id = ? WHERE owner_id = ?`, []any{owner, mine}},
			{`UPDATE messages SET owner_id = ? WHERE owner_id = ?`, []any{owner, mine}},
			{`DELETE FROM links WHERE owner_id = ?`, []any{mine}},
			{`DELETE FROM owners WHERE id = ?`, []any{mine}},
		}
		for _, st := range steps {
			if _, err := tx.ExecContext(ctx, st.q, st.args...); err != nil {
				return "", err
			}
		}
	}
	return bundle, tx.Commit()
}
