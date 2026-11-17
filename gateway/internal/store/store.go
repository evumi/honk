// Package store keeps devices, bots and the short-term message queue in SQLite.
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaV1 string

// ErrNotFound is returned when a row does not exist or belongs to another device.
var ErrNotFound = errors.New("not found")

// Store is the SQLite-backed store. It is safe for concurrent use.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

// Open opens (creating if needed) the database at path and applies migrations.
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection serialises writes; SQLite is fast enough for this load and
	// it avoids SQLITE_BUSY between our own goroutines.
	db.SetMaxOpenConns(1)
	s := &Store{db: db, now: time.Now}
	if err := s.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// SetClock replaces the clock; tests use it.
func (s *Store) SetClock(now func() time.Time) { s.now = now }

func (s *Store) migrate(ctx context.Context) error {
	var v int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil {
		return err
	}
	steps := []func(context.Context, *sql.Tx) error{
		func(ctx context.Context, tx *sql.Tx) error { _, err := tx.ExecContext(ctx, schemaV1); return err },
		migrateV2,
	}
	for ; v < len(steps); v++ {
		if err := s.step(ctx, v+1, steps[v]); err != nil {
			return fmt.Errorf("migrate to v%d: %w", v+1, err)
		}
	}
	return nil
}

// step runs one migration and records its version in the same transaction.
func (s *Store) step(ctx context.Context, version int, f func(context.Context, *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := f(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
		return err
	}
	return tx.Commit()
}

// migrateV2 gives every bot a short random public id. The integer row id stays
// the private key that messages point at; clients and tokens only ever see the
// public id. Existing tokens ("<row id>:<secret>") keep working, since a token
// is looked up by the hash of the whole string.
func migrateV2(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `ALTER TABLE bots ADD COLUMN public_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id FROM bots`)
	if err != nil {
		return err
	}
	var keys []int64
	for rows.Next() {
		var k int64
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, k)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, k := range keys {
		id, err := newBotID(ctx, tx)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE bots SET public_id = ? WHERE id = ?`, id, k); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `CREATE UNIQUE INDEX bots_public_id ON bots(public_id)`)
	return err
}

// Bot ids are botIDLen characters of base62 starting with a letter, so one can
// never be mistaken for the integer ids of v1.
const (
	botIDLen     = 8
	letters      = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	base62       = "0123456789" + letters
	maxIDRetries = 10
)

func randomBotID() string {
	b := make([]byte, botIDLen)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	out := make([]byte, botIDLen)
	// The modulo bias (256 % 62) is irrelevant here: ids are not secrets.
	out[0] = letters[int(b[0])%len(letters)]
	for i := 1; i < botIDLen; i++ {
		out[i] = base62[int(b[i])%len(base62)]
	}
	return string(out)
}

// newBotID returns a public id no bot has yet.
func newBotID(ctx context.Context, tx *sql.Tx) (string, error) {
	for i := 0; i < maxIDRetries; i++ {
		id := randomBotID()
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM bots WHERE public_id = ?`, id).Scan(&n); err != nil {
			return "", err
		}
		if n == 0 {
			return id, nil
		}
	}
	return "", errors.New("no free bot id")
}

// ValidBotID reports whether s has the shape of a bot id.
func ValidBotID(s string) bool {
	if len(s) != botIDLen || !strings.ContainsRune(letters, rune(s[0])) {
		return false
	}
	for i := 1; i < len(s); i++ {
		if !strings.ContainsRune(base62, rune(s[i])) {
			return false
		}
	}
	return true
}

func (s *Store) ms() int64 { return s.now().UnixMilli() }

func hash(secret string) []byte {
	h := sha256.Sum256([]byte(secret))
	return h[:]
}

func randomSecret(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// ---- devices ----

// Device is a phone that receives pushes. It owns bots.
type Device struct {
	ID        string `json:"id"`
	Platform  string `json:"platform"`
	PushToken string `json:"-"`
	PushOK    bool   `json:"push_ok"`
	CreatedAt int64  `json:"created_at"`
}

// CreateDevice registers a device and returns it with its secret. The secret is
// shown once; only its hash is stored.
func (s *Store) CreateDevice(ctx context.Context, platform, pushToken string) (Device, string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return Device{}, "", err
	}
	secret := randomSecret(32)
	now := s.ms()
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO devices (id, secret_hash, platform, push_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id.String(), hash(secret), platform, pushToken, now, now)
	if err != nil {
		return Device{}, "", err
	}
	return Device{ID: id.String(), Platform: platform, PushToken: pushToken, PushOK: true, CreatedAt: now}, secret, nil
}

// DeviceBySecret finds the device a secret belongs to.
func (s *Store) DeviceBySecret(ctx context.Context, secret string) (Device, error) {
	var d Device
	err := s.db.QueryRowContext(ctx,
		`SELECT id, platform, push_token, push_ok, created_at FROM devices WHERE secret_hash = ?`, hash(secret)).
		Scan(&d.ID, &d.Platform, &d.PushToken, &d.PushOK, &d.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return d, ErrNotFound
	}
	return d, err
}

// UpdatePushToken stores a new APNs/FCM token and marks it usable again.
func (s *Store) UpdatePushToken(ctx context.Context, deviceID, token string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE devices SET push_token = ?, push_ok = 1, updated_at = ? WHERE id = ?`, token, s.ms(), deviceID)
	return err
}

// MarkPushGone records that APNs/FCM said the token no longer exists. Only the
// token that failed is marked, so a newer one registered meanwhile survives.
func (s *Store) MarkPushGone(ctx context.Context, deviceID, token string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE devices SET push_ok = 0, updated_at = ? WHERE id = ? AND push_token = ?`, s.ms(), deviceID, token)
	return err
}

// DeleteDevice removes a device with its bots and queued messages.
func (s *Store) DeleteDevice(ctx context.Context, deviceID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE device_id = ?`, deviceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM devices WHERE id = ?`, deviceID); err != nil {
		return err
	}
	return tx.Commit()
}

// ---- bots ----

// Bot is one notification channel. ID is the short public id; Key is the
// private row id that queued messages reference.
type Bot struct {
	ID           string `json:"id"`
	Key          int64  `json:"-"`
	DeviceID     string `json:"-"`
	Name         string `json:"name"`
	Avatar       string `json:"avatar"`
	DefaultLevel string `json:"default_level"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
}

const botCols = `public_id, id, device_id, name, avatar, default_level, created_at, updated_at`

func scanBot(row interface{ Scan(...any) error }) (Bot, error) {
	var b Bot
	err := row.Scan(&b.ID, &b.Key, &b.DeviceID, &b.Name, &b.Avatar, &b.DefaultLevel, &b.CreatedAt, &b.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return b, ErrNotFound
	}
	return b, err
}

func botToken(id string) string { return id + ":" + randomSecret(24) }

// CreateBot adds a bot to a device and returns it with its token, shown once.
func (s *Store) CreateBot(ctx context.Context, deviceID, name, avatar, level string) (Bot, string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Bot{}, "", err
	}
	defer tx.Rollback()
	now := s.ms()
	id, err := newBotID(ctx, tx)
	if err != nil {
		return Bot{}, "", err
	}
	token := botToken(id)
	res, err := tx.ExecContext(ctx,
		`INSERT INTO bots (public_id, device_id, token_hash, name, avatar, default_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, deviceID, hash(token), name, avatar, level, now, now)
	if err != nil {
		return Bot{}, "", err
	}
	key, err := res.LastInsertId()
	if err != nil {
		return Bot{}, "", err
	}
	if err := tx.Commit(); err != nil {
		return Bot{}, "", err
	}
	return Bot{ID: id, Key: key, DeviceID: deviceID, Name: name, Avatar: avatar, DefaultLevel: level, CreatedAt: now, UpdatedAt: now}, token, nil
}

// ListBots returns a device's bots, oldest first.
func (s *Store) ListBots(ctx context.Context, deviceID string) ([]Bot, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+botCols+` FROM bots WHERE device_id = ? ORDER BY id`, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bots := []Bot{}
	for rows.Next() {
		b, err := scanBot(rows)
		if err != nil {
			return nil, err
		}
		bots = append(bots, b)
	}
	return bots, rows.Err()
}

// CountBots returns how many bots a device has.
func (s *Store) CountBots(ctx context.Context, deviceID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM bots WHERE device_id = ?`, deviceID).Scan(&n)
	return n, err
}

// GetBot returns one of a device's bots.
func (s *Store) GetBot(ctx context.Context, deviceID string, botID string) (Bot, error) {
	return scanBot(s.db.QueryRowContext(ctx, `SELECT `+botCols+` FROM bots WHERE public_id = ? AND device_id = ?`, botID, deviceID))
}

// BotIDByKey returns the public id of one of a device's bots by its row id:
// the integer id clients knew before v2.
func (s *Store) BotIDByKey(ctx context.Context, deviceID string, key int64) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT public_id FROM bots WHERE id = ? AND device_id = ?`, key, deviceID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return id, err
}

// BotPatch holds the fields to change; nil leaves a field as it is.
type BotPatch struct {
	Name         *string
	Avatar       *string
	DefaultLevel *string
}

// UpdateBot changes a bot's name, avatar or default level.
func (s *Store) UpdateBot(ctx context.Context, deviceID string, botID string, p BotPatch) (Bot, error) {
	b, err := s.GetBot(ctx, deviceID, botID)
	if err != nil {
		return b, err
	}
	if p.Name != nil {
		b.Name = *p.Name
	}
	if p.Avatar != nil {
		b.Avatar = *p.Avatar
	}
	if p.DefaultLevel != nil {
		b.DefaultLevel = *p.DefaultLevel
	}
	b.UpdatedAt = s.ms()
	_, err = s.db.ExecContext(ctx,
		`UPDATE bots SET name = ?, avatar = ?, default_level = ?, updated_at = ? WHERE public_id = ? AND device_id = ?`,
		b.Name, b.Avatar, b.DefaultLevel, b.UpdatedAt, botID, deviceID)
	return b, err
}

// ResetBotToken replaces a bot's token; the old one stops working at once.
func (s *Store) ResetBotToken(ctx context.Context, deviceID string, botID string) (string, error) {
	token := botToken(botID)
	res, err := s.db.ExecContext(ctx,
		`UPDATE bots SET token_hash = ?, updated_at = ? WHERE public_id = ? AND device_id = ?`, hash(token), s.ms(), botID, deviceID)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", ErrNotFound
	}
	return token, nil
}

// DeleteBot removes a bot and its queued messages.
func (s *Store) DeleteBot(ctx context.Context, deviceID string, botID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM bots WHERE public_id = ? AND device_id = ?`, botID, deviceID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// BotByToken resolves a bot token to the bot and the device it pushes to.
func (s *Store) BotByToken(ctx context.Context, token string) (Bot, Device, error) {
	var b Bot
	var d Device
	// Reject malformed tokens before touching the database.
	if i := strings.IndexByte(token, ':'); i <= 0 || i == len(token)-1 {
		return b, d, ErrNotFound
	}
	err := s.db.QueryRowContext(ctx, `
		SELECT b.public_id, b.id, b.device_id, b.name, b.avatar, b.default_level, b.created_at, b.updated_at,
		       d.id, d.platform, d.push_token, d.push_ok, d.created_at
		FROM bots b JOIN devices d ON d.id = b.device_id
		WHERE b.token_hash = ?`, hash(token)).
		Scan(&b.ID, &b.Key, &b.DeviceID, &b.Name, &b.Avatar, &b.DefaultLevel, &b.CreatedAt, &b.UpdatedAt,
			&d.ID, &d.Platform, &d.PushToken, &d.PushOK, &d.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return b, d, ErrNotFound
	}
	return b, d, err
}
