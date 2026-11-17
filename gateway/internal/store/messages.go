package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Message kinds.
const (
	KindMessage = "message"
	KindEdit    = "edit"
	KindDelete  = "delete"
)

// Message is one queued item. For an edit or delete, TargetID and/or
// CollapseID say which message it applies to, and Data is the new state.
type Message struct {
	ID         int64  `json:"message_id"`
	BotID      string `json:"bot_id"` // the bot's public id
	BotKey     int64  `json:"-"`      // the bot's row id
	DeviceID   string `json:"-"`
	Kind       string `json:"kind"`
	TargetID   int64  `json:"target_id,omitempty"`
	Title      string `json:"title,omitempty"`
	Body       string `json:"body,omitempty"`
	HTML       string `json:"html,omitempty"`
	Data       string `json:"data,omitempty"`
	Level      string `json:"level,omitempty"`
	Group      string `json:"group,omitempty"`
	URL        string `json:"url,omitempty"`
	Copy       string `json:"copy,omitempty"`
	Icon       string `json:"icon,omitempty"`
	CollapseID string `json:"id,omitempty"`
	CreatedAt  int64  `json:"date"`
	ExpiresAt  int64  `json:"-"`
}

// msgSelect reads messages with their bot's public id.
const msgSelect = `SELECT m.id, b.public_id, m.bot_id, m.device_id, m.kind, m.target_id, m.title, m.body, m.html, m.data, m.level,
	m.group_key, m.url, m.copy_text, m.icon, m.collapse_id, m.created_at, m.expires_at
	FROM messages m JOIN bots b ON b.id = m.bot_id`

func scanMessage(row interface{ Scan(...any) error }) (Message, error) {
	var m Message
	err := row.Scan(&m.ID, &m.BotID, &m.BotKey, &m.DeviceID, &m.Kind, &m.TargetID, &m.Title, &m.Body, &m.HTML, &m.Data,
		&m.Level, &m.Group, &m.URL, &m.Copy, &m.Icon, &m.CollapseID, &m.CreatedAt, &m.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

func insert(ctx context.Context, tx *sql.Tx, m *Message) error {
	res, err := tx.ExecContext(ctx, `
		INSERT INTO messages (bot_id, device_id, kind, target_id, title, body, html, data, level, group_key, url, copy_text, icon, collapse_id, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.BotKey, m.DeviceID, m.Kind, m.TargetID, m.Title, m.Body, m.HTML, m.Data, m.Level, m.Group, m.URL, m.Copy, m.Icon,
		m.CollapseID, m.CreatedAt, m.ExpiresAt)
	if err != nil {
		return err
	}
	m.ID, err = res.LastInsertId()
	return err
}

// AddMessage queues a new message from bot. A message with the same collapse
// id from the same bot replaces the earlier ones still in the queue.
func (s *Store) AddMessage(ctx context.Context, bot Bot, m Message, ttl time.Duration) (Message, error) {
	now := s.now()
	m.BotID, m.BotKey = bot.ID, bot.Key
	m.Kind = KindMessage
	m.TargetID = 0
	m.CreatedAt = now.UnixMilli()
	m.ExpiresAt = now.Add(ttl).UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return m, err
	}
	defer tx.Rollback()
	if m.CollapseID != "" {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM messages WHERE bot_id = ? AND collapse_id = ? AND kind = 'message'`, m.BotKey, m.CollapseID); err != nil {
			return m, err
		}
	}
	if err := insert(ctx, tx, &m); err != nil {
		return m, err
	}
	return m, tx.Commit()
}

// Target names the message an edit or delete applies to: by id, or by the
// collapse id given when it was sent.
type Target struct {
	MessageID  int64
	CollapseID string
}

// resolve fills in whichever half of t is missing from the queued message, if
// that message is still queued and belongs to the bot.
func resolve(ctx context.Context, tx *sql.Tx, botID int64, t Target) (Target, error) {
	var q string
	var arg any
	switch {
	case t.MessageID > 0:
		q, arg = `SELECT id, collapse_id FROM messages WHERE bot_id = ? AND kind = 'message' AND id = ?`, t.MessageID
	case t.CollapseID != "":
		q, arg = `SELECT id, collapse_id FROM messages WHERE bot_id = ? AND kind = 'message' AND collapse_id = ? ORDER BY id DESC LIMIT 1`, t.CollapseID
	default:
		return t, errors.New("target needs a message id or a collapse id")
	}
	var r Target
	err := tx.QueryRowContext(ctx, q, botID, arg).Scan(&r.MessageID, &r.CollapseID)
	if errors.Is(err, sql.ErrNoRows) {
		return t, nil // already delivered and cleaned up; the client still has it
	}
	return r, err
}

// EditData queues a change to a message's data and updates the queued copy if
// it is still there.
func (s *Store) EditData(ctx context.Context, bot Bot, deviceID string, t Target, data string, ttl time.Duration) (Message, error) {
	return s.change(ctx, KindEdit, bot, deviceID, t, data, ttl)
}

// DeleteMessage queues a delete and drops the queued copy if it is still there.
func (s *Store) DeleteMessage(ctx context.Context, bot Bot, deviceID string, t Target, ttl time.Duration) (Message, error) {
	return s.change(ctx, KindDelete, bot, deviceID, t, "", ttl)
}

func (s *Store) change(ctx context.Context, kind string, bot Bot, deviceID string, t Target, data string, ttl time.Duration) (Message, error) {
	now := s.now()
	botID := bot.Key
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	t, err = resolve(ctx, tx, botID, t)
	if err != nil {
		return Message{}, err
	}
	if t.MessageID > 0 {
		var q string
		var args []any
		if kind == KindEdit {
			q, args = `UPDATE messages SET data = ? WHERE id = ? AND bot_id = ? AND kind = 'message'`, []any{data, t.MessageID, botID}
		} else {
			// Earlier edits of a deleted message are moot too.
			q, args = `DELETE FROM messages WHERE bot_id = ? AND (id = ? OR (kind = 'edit' AND target_id = ?))`, []any{botID, t.MessageID, t.MessageID}
		}
		if _, err := tx.ExecContext(ctx, q, args...); err != nil {
			return Message{}, err
		}
	}
	m := Message{
		BotID: bot.ID, BotKey: botID, DeviceID: deviceID, Kind: kind, TargetID: t.MessageID, CollapseID: t.CollapseID, Data: data,
		CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(ttl).UnixMilli(),
	}
	if err := insert(ctx, tx, &m); err != nil {
		return Message{}, err
	}
	return m, tx.Commit()
}

// GetMessage returns a queued item of the device.
func (s *Store) GetMessage(ctx context.Context, deviceID string, id int64) (Message, error) {
	return scanMessage(s.db.QueryRowContext(ctx,
		msgSelect+` WHERE m.id = ? AND m.device_id = ? AND m.expires_at > ?`, id, deviceID, s.ms()))
}

// Sync returns the device's queued items after cursor, oldest first.
func (s *Store) Sync(ctx context.Context, deviceID string, cursor int64, limit int) ([]Message, error) {
	rows, err := s.db.QueryContext(ctx,
		msgSelect+` WHERE m.device_id = ? AND m.id > ? AND m.expires_at > ? ORDER BY m.id LIMIT ?`,
		deviceID, cursor, s.ms(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Ack marks every item up to and including upTo as stored on the device.
func (s *Store) Ack(ctx context.Context, deviceID string, upTo int64) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE messages SET acked_at = ? WHERE device_id = ? AND id <= ? AND acked_at IS NULL`, s.ms(), deviceID, upTo)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Cleanup deletes expired items and items acked longer than ackedKeep ago.
func (s *Store) Cleanup(ctx context.Context, ackedKeep time.Duration) (int64, error) {
	now := s.now()
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM messages WHERE expires_at <= ? OR (acked_at IS NOT NULL AND acked_at <= ?)`,
		now.UnixMilli(), now.Add(-ackedKeep).UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
