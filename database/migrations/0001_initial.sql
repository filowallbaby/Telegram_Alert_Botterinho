CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  input_chat_id INTEGER NOT NULL,
  input_message_id INTEGER NOT NULL,
  prompt_message_id INTEGER,
  latitude REAL NOT NULL CHECK(latitude BETWEEN -85.05112878 AND 85.05112878),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  category TEXT CHECK(category IN ('accident','traffic','closure','roadworks','hazard','weather')),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
  created_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  published_report_id INTEGER
);
CREATE INDEX drafts_owner ON drafts(user_id, input_chat_id, created_at DESC);
CREATE INDEX drafts_prompt ON drafts(input_chat_id, prompt_message_id, user_id);
CREATE INDEX drafts_expiry ON drafts(expires_at);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL UNIQUE,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  latitude REAL NOT NULL CHECK(latitude BETWEEN -85.05112878 AND 85.05112878),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  category TEXT NOT NULL CHECK(category IN ('accident','traffic','closure','roadworks','hazard','weather')),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','resolved','expired','removed')),
  created_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_confirmed_at INTEGER,
  resolved_at INTEGER,
  message_id INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 1,
  delivery_lock_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  delivery_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX reports_active ON reports(chat_id, status, expires_at);
CREATE INDEX reports_history ON reports(chat_id, created_at DESC, id DESC);
CREATE INDEX reports_owner ON reports(user_id, created_at DESC);
CREATE INDEX reports_delivery ON reports(dirty, retry_at);

CREATE TABLE votes (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('confirm','clear')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(report_id, user_id)
);
CREATE INDEX votes_recent ON votes(report_id, kind, created_at);

-- State changes only. Group messages are never stored here.
CREATE TABLE report_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX history_report ON report_history(report_id, created_at);

-- Used to skip updates Telegram sends twice. The update payload itself is not stored.
CREATE TABLE processed_updates (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('processing','done')),
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX updates_expiry ON processed_updates(updated_at);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rates_expiry ON rate_limits(expires_at);
