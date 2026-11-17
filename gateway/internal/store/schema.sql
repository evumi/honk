-- Version 1. Timestamps are Unix milliseconds.

CREATE TABLE devices (
  id          TEXT PRIMARY KEY,               -- UUIDv7
  secret_hash BLOB NOT NULL UNIQUE,           -- sha256 of the device secret
  platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  push_token  TEXT NOT NULL,
  push_ok     INTEGER NOT NULL DEFAULT 1,     -- 0 after APNs/FCM reports the token gone
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE bots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash    BLOB NOT NULL UNIQUE,         -- sha256 of the whole "<id>:<secret>" token
  name          TEXT NOT NULL,
  avatar        TEXT NOT NULL DEFAULT '',
  default_level TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX bots_device ON bots(device_id);

-- The short-term queue. kind = message | edit | delete. An edit or delete
-- points at its message by target_id and/or collapse_id; the client applies it
-- to its local copy, so the target may already be gone from this table.
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT, -- also the /sync cursor
  bot_id      INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('message', 'edit', 'delete')),
  target_id   INTEGER NOT NULL DEFAULT 0,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  html        TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL DEFAULT '',
  level       TEXT NOT NULL DEFAULT '',
  group_key   TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  copy_text   TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '',
  collapse_id TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  acked_at    INTEGER
);
CREATE INDEX messages_sync ON messages(device_id, id);
CREATE INDEX messages_collapse ON messages(bot_id, collapse_id) WHERE collapse_id <> '';
CREATE INDEX messages_expiry ON messages(expires_at);
