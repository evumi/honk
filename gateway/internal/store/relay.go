package store

import (
	"context"
	"database/sql"
	"errors"
)

// GetMeta returns a setting of this gateway, or "" when it is not set.
func (s *Store) GetMeta(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetMeta stores a setting; an empty value removes it.
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	if value == "" {
		_, err := s.db.ExecContext(ctx, `DELETE FROM meta WHERE key = ?`, key)
		return err
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// Relay is a self-hosted gateway that registered to use this gateway as a push relay.
type Relay struct {
	ID         string `json:"id"`
	CreatedAt  int64  `json:"created_at"`
	LastUsedAt int64  `json:"last_used_at"`
	Blocked    bool   `json:"blocked"`
}

// CreateRelay registers a relay and returns it with its key. The key is shown
// once; only its hash is stored.
func (s *Store) CreateRelay(ctx context.Context) (Relay, string, error) {
	key := randomSecret(32)
	r := Relay{ID: "r" + randomSecret(9), CreatedAt: s.ms()}
	_, err := s.db.ExecContext(ctx, `INSERT INTO relays (id, key_hash, created_at) VALUES (?, ?, ?)`, r.ID, hash(key), r.CreatedAt)
	if err != nil {
		return Relay{}, "", err
	}
	return r, key, nil
}

// RelayByKey finds the relay a key belongs to.
func (s *Store) RelayByKey(ctx context.Context, key string) (Relay, error) {
	var r Relay
	err := s.db.QueryRowContext(ctx,
		`SELECT id, created_at, last_used_at, blocked FROM relays WHERE key_hash = ?`, hash(key)).
		Scan(&r.ID, &r.CreatedAt, &r.LastUsedAt, &r.Blocked)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	return r, err
}

// TouchRelay records that the relay was just used.
func (s *Store) TouchRelay(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE relays SET last_used_at = ? WHERE id = ?`, s.ms(), id)
	return err
}

// BlockRelay blocks or unblocks a relay.
func (s *Store) BlockRelay(ctx context.Context, id string, blocked bool) error {
	res, err := s.db.ExecContext(ctx, `UPDATE relays SET blocked = ? WHERE id = ?`, blocked, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
