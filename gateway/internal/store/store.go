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
		migrateV3,
		migrateV4,
		migrateSendOptions,
		migrateWidgetQueries,
		migrateEncryption,
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

// migrateSendOptions (v3) adds the sendMessage options open, image,
// parse_mode and silent to the queue.
func migrateSendOptions(ctx context.Context, tx *sql.Tx) error {
	for _, q := range []string{
		`ALTER TABLE messages ADD COLUMN open_mode TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE messages ADD COLUMN image TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE messages ADD COLUMN parse_mode TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE messages ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`,
	} {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
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

// migrateV3 adds the push relay's tables: relays (the self-hosted gateways this
// gateway relays for) and meta (small key/value settings of this gateway, such
// as the credentials it got from a relay).
func migrateV3(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
CREATE TABLE relays (
  id           TEXT PRIMARY KEY,
  key_hash     BLOB NOT NULL UNIQUE,          -- sha256 of the relay key
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  blocked      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`)
	return err
}

// migrateV4 adds device groups. owners is the group; devices, bots and messages
// point at it with owner_id, and the owner is what scopes sync, ack and the bot
// list from here on. Every existing device becomes a group of its own, so
// nothing changes for it. The old device_id columns of bots and messages stay
// (SQLite cannot drop a column that has a foreign key without rebuilding the
// table, which would cascade): bots.device_id is now only the creator, and
// messages.device_id is no longer written. devices gains the name, the last
// time it was seen and its ack watermark, derived from the per-message acks of
// v1. links holds the pairing bundles.
func migrateV4(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
CREATE TABLE owners (
  id         TEXT PRIMARY KEY,                -- UUIDv7, opaque
  created_at INTEGER NOT NULL
);
ALTER TABLE devices ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN acked_up_to INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bots ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
CREATE TABLE links (
  link_hash  BLOB PRIMARY KEY,                -- sha256 of the link id
  owner_id   TEXT NOT NULL,
  bundle     TEXT NOT NULL,                   -- opaque to the gateway
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX links_owner ON links(owner_id);
UPDATE devices SET seen_at = updated_at,
  acked_up_to = COALESCE(
    (SELECT MIN(id) - 1 FROM messages WHERE device_id = devices.id AND acked_at IS NULL),
    (SELECT MAX(id) FROM messages WHERE device_id = devices.id), 0);`)
	if err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id FROM devices`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	for _, id := range ids {
		o, err := uuid.NewV7()
		if err != nil {
			return err
		}
		for _, q := range []string{
			`INSERT INTO owners (id, created_at) VALUES (?1, ?2)`,
			`UPDATE devices SET owner_id = ?1 WHERE id = ?3`,
			`UPDATE bots SET owner_id = ?1 WHERE device_id = ?3`,
			`UPDATE messages SET owner_id = ?1 WHERE device_id = ?3`,
		} {
			if _, err := tx.ExecContext(ctx, q, o.String(), now, id); err != nil {
				return err
			}
		}
	}
	_, err = tx.ExecContext(ctx, `
CREATE INDEX devices_owner ON devices(owner_id);
CREATE INDEX bots_owner ON bots(owner_id);
CREATE INDEX messages_owner ON messages(owner_id, id);`)
	return err
}

// migrateWidgetQueries adds what widget queries (card request()) need: whether
// a message's card may query its bot, and the bot's webhook.
func migrateWidgetQueries(ctx context.Context, tx *sql.Tx) error {
	for _, q := range []string{
		`ALTER TABLE messages ADD COLUMN allow_queries INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE bots ADD COLUMN webhook_url TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE bots ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}

// migrateEncryption adds end-to-end encryption: bots.encrypted (the device
// turned it on; plaintext sends are then refused), messages.ciphertext (the
// sealed content, which the gateway stores and never reads).
func migrateEncryption(ctx context.Context, tx *sql.Tx) error {
	for _, q := range []string{
		`ALTER TABLE bots ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE messages ADD COLUMN ciphertext TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
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

// Device is a phone that receives pushes. Devices that were paired together
// share an owner (the device group) and with it the bots and the queue.
type Device struct {
	ID        string `json:"id"`
	OwnerID   string `json:"-"`
	Name      string `json:"name"`
	Platform  string `json:"platform"`
	PushToken string `json:"-"`
	PushOK    bool   `json:"push_ok"`
	CreatedAt int64  `json:"created_at"`
	SeenAt    int64  `json:"seen_at"`
	// AckedUpTo is the device's ack watermark: it has stored every queued item
	// up to and including this id.
	AckedUpTo int64 `json:"-"`
}

const devCols = `id, owner_id, name, platform, push_token, push_ok, created_at, seen_at, acked_up_to`

func scanDevice(row interface{ Scan(...any) error }) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.OwnerID, &d.Name, &d.Platform, &d.PushToken, &d.PushOK, &d.CreatedAt, &d.SeenAt, &d.AckedUpTo)
	if errors.Is(err, sql.ErrNoRows) {
		return d, ErrNotFound
	}
	return d, err
}

// CreateDevice registers a device in a new device group of its own and returns
// it with its secret. The secret is shown once; only its hash is stored.
func (s *Store) CreateDevice(ctx context.Context, platform, pushToken, name string) (Device, string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return Device{}, "", err
	}
	owner, err := uuid.NewV7()
	if err != nil {
		return Device{}, "", err
	}
	secret := randomSecret(32)
	now := s.ms()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Device{}, "", err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO owners (id, created_at) VALUES (?, ?)`, owner.String(), now); err != nil {
		return Device{}, "", err
	}
	_, err = tx.ExecContext(ctx,
		`INSERT INTO devices (id, owner_id, name, secret_hash, platform, push_token, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id.String(), owner.String(), name, hash(secret), platform, pushToken, now, now, now)
	if err != nil {
		return Device{}, "", err
	}
	if err := tx.Commit(); err != nil {
		return Device{}, "", err
	}
	return Device{ID: id.String(), OwnerID: owner.String(), Name: name, Platform: platform, PushToken: pushToken, PushOK: true, CreatedAt: now, SeenAt: now}, secret, nil
}

// DeviceBySecret finds the device a secret belongs to.
func (s *Store) DeviceBySecret(ctx context.Context, secret string) (Device, error) {
	return scanDevice(s.db.QueryRowContext(ctx, `SELECT `+devCols+` FROM devices WHERE secret_hash = ?`, hash(secret)))
}

// TouchDevice records that the device was just seen.
func (s *Store) TouchDevice(ctx context.Context, deviceID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE devices SET seen_at = ? WHERE id = ?`, s.ms(), deviceID)
	return err
}

// ListDevices returns the devices of a group, oldest first.
func (s *Store) ListDevices(ctx context.Context, ownerID string) ([]Device, error) {
	return s.devices(ctx, `SELECT `+devCols+` FROM devices WHERE owner_id = ? ORDER BY created_at, id`, ownerID)
}

// PushDevices returns the devices of a group that can be pushed to.
func (s *Store) PushDevices(ctx context.Context, ownerID string) ([]Device, error) {
	return s.devices(ctx, `SELECT `+devCols+` FROM devices WHERE owner_id = ? AND push_ok = 1 AND push_token <> '' ORDER BY created_at, id`, ownerID)
}

func (s *Store) devices(ctx context.Context, q string, args ...any) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// UpdateDevice stores a new push token (which marks it usable again) and/or a
// new name; an empty value leaves the field as it is.
func (s *Store) UpdateDevice(ctx context.Context, deviceID, pushToken, name string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE devices SET push_token = CASE WHEN ? <> '' THEN ? ELSE push_token END,
		   push_ok = CASE WHEN ? <> '' THEN 1 ELSE push_ok END,
		   name = CASE WHEN ? <> '' THEN ? ELSE name END, updated_at = ? WHERE id = ?`,
		pushToken, pushToken, pushToken, name, name, s.ms(), deviceID)
	return err
}

// MarkPushGone records that APNs/FCM said the token no longer exists. Only the
// token that failed is marked, so a newer one registered meanwhile survives.
func (s *Store) MarkPushGone(ctx context.Context, deviceID, token string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE devices SET push_ok = 0, updated_at = ? WHERE id = ? AND push_token = ?`, s.ms(), deviceID, token)
	return err
}

// DeleteDevice removes a device from its group. When it was the last one, the
// group goes too, with its bots and queued messages; the result says so.
func (s *Store) DeleteDevice(ctx context.Context, deviceID string) (groupGone bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	groupGone, err = deleteDevice(ctx, tx, deviceID)
	if err != nil {
		return false, err
	}
	return groupGone, tx.Commit()
}

func deleteDevice(ctx context.Context, tx *sql.Tx, deviceID string) (bool, error) {
	var owner string
	if err := tx.QueryRowContext(ctx, `SELECT owner_id FROM devices WHERE id = ?`, deviceID).Scan(&owner); errors.Is(err, sql.ErrNoRows) {
		return false, ErrNotFound
	} else if err != nil {
		return false, err
	}
	var other string
	err := tx.QueryRowContext(ctx, `SELECT id FROM devices WHERE owner_id = ? AND id <> ? ORDER BY created_at LIMIT 1`, owner, deviceID).Scan(&other)
	if errors.Is(err, sql.ErrNoRows) {
		return true, deleteOwner(ctx, tx, owner)
	}
	if err != nil {
		return false, err
	}
	// bots.device_id (the creator, kept from v1) cascades; it no longer decides
	// who may use a bot, so hand the bots to a device that stays.
	if _, err := tx.ExecContext(ctx, `UPDATE bots SET device_id = ? WHERE device_id = ?`, other, deviceID); err != nil {
		return false, err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM devices WHERE id = ?`, deviceID)
	return false, err
}

// DeleteOwner removes a whole device group: its devices, bots and queue.
func (s *Store) DeleteOwner(ctx context.Context, ownerID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := deleteOwner(ctx, tx, ownerID); err != nil {
		return err
	}
	return tx.Commit()
}

func deleteOwner(ctx context.Context, tx *sql.Tx, ownerID string) error {
	for _, q := range []string{
		`DELETE FROM messages WHERE owner_id = ?`,
		`DELETE FROM bots WHERE owner_id = ?`,
		`DELETE FROM links WHERE owner_id = ?`,
		`DELETE FROM devices WHERE owner_id = ?`,
		`DELETE FROM owners WHERE id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, q, ownerID); err != nil {
			return err
		}
	}
	return nil
}

// GCDevices deletes devices whose push token is gone and that made no request
// for idle (with the group, its bots and queue, when such a device was the
// last of its group). It returns how many devices went.
func (s *Store) GCDevices(ctx context.Context, idle time.Duration) (int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM devices WHERE push_ok = 0 AND seen_at <= ?`, s.now().Add(-idle).UnixMilli())
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	n := 0
	for _, id := range ids {
		if _, err := s.DeleteDevice(ctx, id); err != nil && !errors.Is(err, ErrNotFound) {
			return n, err
		}
		n++
	}
	return n, nil
}

// ---- bots ----

// Bot is one notification channel. ID is the short public id; Key is the
// private row id that queued messages reference. OwnerID is the device group
// that may use it.
type Bot struct {
	ID           string `json:"id"`
	Key          int64  `json:"-"`
	OwnerID      string `json:"-"`
	Name         string `json:"name"`
	Avatar       string `json:"avatar"`
	DefaultLevel string `json:"default_level"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
	// Encrypted: messages must be sent as end-to-end encrypted ciphertext.
	Encrypted bool `json:"encrypted"`

	// WebhookURL and WebhookSecret are where widget queries go (setWebhook).
	WebhookURL    string `json:"-"`
	WebhookSecret string `json:"-"`
}

const botCols = `public_id, id, owner_id, name, avatar, default_level, encrypted, created_at, updated_at, webhook_url, webhook_secret`

func scanBot(row interface{ Scan(...any) error }) (Bot, error) {
	var b Bot
	err := row.Scan(&b.ID, &b.Key, &b.OwnerID, &b.Name, &b.Avatar, &b.DefaultLevel, &b.Encrypted, &b.CreatedAt, &b.UpdatedAt, &b.WebhookURL, &b.WebhookSecret)
	if errors.Is(err, sql.ErrNoRows) {
		return b, ErrNotFound
	}
	return b, err
}

func botToken(id string) string { return id + ":" + randomSecret(24) }

// CreateBot adds a bot to the device's group and returns it with its token,
// shown once.
func (s *Store) CreateBot(ctx context.Context, d Device, name, avatar, level string) (Bot, string, error) {
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
	// device_id is the creator, kept from v1 for its foreign key.
	res, err := tx.ExecContext(ctx,
		`INSERT INTO bots (public_id, device_id, owner_id, token_hash, name, avatar, default_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, d.ID, d.OwnerID, hash(token), name, avatar, level, now, now)
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
	return Bot{ID: id, Key: key, OwnerID: d.OwnerID, Name: name, Avatar: avatar, DefaultLevel: level, CreatedAt: now, UpdatedAt: now}, token, nil
}

// ListBots returns a group's bots, oldest first.
func (s *Store) ListBots(ctx context.Context, ownerID string) ([]Bot, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+botCols+` FROM bots WHERE owner_id = ? ORDER BY id`, ownerID)
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

// CountBots returns how many bots a group has.
func (s *Store) CountBots(ctx context.Context, ownerID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM bots WHERE owner_id = ?`, ownerID).Scan(&n)
	return n, err
}

// Counts returns how many devices and bots exist.
func (s *Store) Counts(ctx context.Context) (devices, bots int, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM devices), (SELECT COUNT(*) FROM bots)`).Scan(&devices, &bots)
	return
}

// GetBot returns one of a group's bots.
func (s *Store) GetBot(ctx context.Context, ownerID string, botID string) (Bot, error) {
	return scanBot(s.db.QueryRowContext(ctx, `SELECT `+botCols+` FROM bots WHERE public_id = ? AND owner_id = ?`, botID, ownerID))
}

// BotIDByKey returns the public id of one of a group's bots by its row id:
// the integer id clients knew before v2.
func (s *Store) BotIDByKey(ctx context.Context, ownerID string, key int64) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT public_id FROM bots WHERE id = ? AND owner_id = ?`, key, ownerID).Scan(&id)
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
	Encrypted    *bool
}

// UpdateBot changes a bot's name, avatar or default level.
func (s *Store) UpdateBot(ctx context.Context, ownerID string, botID string, p BotPatch) (Bot, error) {
	b, err := s.GetBot(ctx, ownerID, botID)
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
	if p.Encrypted != nil {
		b.Encrypted = *p.Encrypted
	}
	b.UpdatedAt = s.ms()
	_, err = s.db.ExecContext(ctx,
		`UPDATE bots SET name = ?, avatar = ?, default_level = ?, encrypted = ?, updated_at = ? WHERE public_id = ? AND owner_id = ?`,
		b.Name, b.Avatar, b.DefaultLevel, b.Encrypted, b.UpdatedAt, botID, ownerID)
	return b, err
}

// ResetBotToken replaces a bot's token; the old one stops working at once.
func (s *Store) ResetBotToken(ctx context.Context, ownerID string, botID string) (string, error) {
	token := botToken(botID)
	res, err := s.db.ExecContext(ctx,
		`UPDATE bots SET token_hash = ?, updated_at = ? WHERE public_id = ? AND owner_id = ?`, hash(token), s.ms(), botID, ownerID)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", ErrNotFound
	}
	return token, nil
}

// DeleteBot removes a bot and its queued messages.
func (s *Store) DeleteBot(ctx context.Context, ownerID string, botID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM bots WHERE public_id = ? AND owner_id = ?`, botID, ownerID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// BotByToken resolves a bot token to the bot. Its OwnerID names the device
// group that gets the pushes (see PushDevices).
func (s *Store) BotByToken(ctx context.Context, token string) (Bot, error) {
	// Reject malformed tokens before touching the database.
	if i := strings.IndexByte(token, ':'); i <= 0 || i == len(token)-1 {
		return Bot{}, ErrNotFound
	}
	return scanBot(s.db.QueryRowContext(ctx, `SELECT `+botCols+` FROM bots WHERE token_hash = ?`, hash(token)))
}

// SetWebhook sets (or with an empty url, clears) where a bot's widget queries
// are delivered.
func (s *Store) SetWebhook(ctx context.Context, botKey int64, url, secret string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE bots SET webhook_url = ?, webhook_secret = ? WHERE id = ?`, url, secret, botKey)
	return err
}
