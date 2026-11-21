PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS projects (
 mint TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 symbol TEXT NOT NULL,
 logo_url TEXT,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_groups (
 mint TEXT NOT NULL,
 chat_id TEXT NOT NULL,
 chat_title TEXT,
 registered_by TEXT NOT NULL,
 registered_at INTEGER NOT NULL,
 PRIMARY KEY(mint, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_project_groups_mint ON project_groups(mint);
CREATE TABLE IF NOT EXISTS draft_state (
 user_id TEXT PRIMARY KEY,
 step TEXT NOT NULL,
 own_mint TEXT,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fights (
 id TEXT PRIMARY KEY,
 mint_a TEXT NOT NULL,
 mint_b TEXT NOT NULL,
 creator_id TEXT NOT NULL,
 accepted_by TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','active','ended','unresolved','declined','cancelled','expired')),
 created_at INTEGER NOT NULL,
 started_at INTEGER,
 ends_at INTEGER,
 settled_at INTEGER,
 archived_at INTEGER,
 start_price_a REAL,
 start_price_b REAL,
 latest_price_a REAL,
 latest_price_b REAL,
 last_price_at INTEGER,
 next_refresh_at INTEGER,
 next_settle_at INTEGER,
 final_votes_a INTEGER,
 final_votes_b INTEGER,
 final_score_a REAL,
 final_score_b REAL,
 winner TEXT,
 FOREIGN KEY(mint_a) REFERENCES projects(mint),
 FOREIGN KEY(mint_b) REFERENCES projects(mint)
);
CREATE INDEX IF NOT EXISTS idx_fights_due ON fights(status,ends_at,next_settle_at);
CREATE INDEX IF NOT EXISTS idx_fights_refresh ON fights(status,next_refresh_at);
CREATE INDEX IF NOT EXISTS idx_fights_history ON fights(status,archived_at);
-- A pair cannot be challenged twice at once, regardless of order. Later rematches are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_open_pair ON fights(
 CASE WHEN mint_a < mint_b THEN mint_a ELSE mint_b END,
 CASE WHEN mint_a < mint_b THEN mint_b ELSE mint_a END
) WHERE status IN ('pending','active');
-- Transactional pair of rows acts as a lock on both tokens for the life of an active fight.
CREATE TABLE IF NOT EXISTS active_token_locks (
 mint TEXT PRIMARY KEY,
 fight_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active_token_locks_fight ON active_token_locks(fight_id);
CREATE TABLE IF NOT EXISTS votes (
 fight_id TEXT NOT NULL,
 voter_id TEXT NOT NULL,
 side TEXT NOT NULL CHECK(side IN ('a','b')),
 voted_at INTEGER NOT NULL,
 PRIMARY KEY (fight_id, voter_id)
);
CREATE TABLE IF NOT EXISTS group_messages (
 fight_id TEXT NOT NULL,
 chat_id TEXT NOT NULL,
 live_message_id INTEGER,
 message_type TEXT NOT NULL DEFAULT 'photo',
 PRIMARY KEY (fight_id, chat_id)
);
CREATE TABLE IF NOT EXISTS sent_events (
 fight_id TEXT NOT NULL,
 chat_id TEXT NOT NULL,
 event_type TEXT NOT NULL,
 sent_at INTEGER NOT NULL,
 PRIMARY KEY (fight_id,chat_id,event_type)
);
