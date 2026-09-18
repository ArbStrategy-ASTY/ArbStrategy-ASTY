-- ASTY Rebound - initial D1 schema
-- Phase 1: permanent mapping between the user's Phantom wallet
-- and the automatically managed Privy Rebound wallet.

CREATE TABLE IF NOT EXISTS rebound_users (
  phantom_address TEXT PRIMARY KEY,
  privy_user_id TEXT UNIQUE,
  rebound_wallet_id TEXT UNIQUE,
  rebound_wallet_address TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rebound_users_privy_user_id
  ON rebound_users (privy_user_id);

CREATE INDEX IF NOT EXISTS idx_rebound_users_rebound_wallet_address
  ON rebound_users (rebound_wallet_address);
