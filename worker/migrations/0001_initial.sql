-- HUSSAM AI API — initial D1 schema
-- This file is a proposal only. It has NOT been applied to any Cloudflare database.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 310000,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  device_key_hash TEXT NOT NULL UNIQUE,
  trial_used INTEGER NOT NULL DEFAULT 0 CHECK (trial_used >= 0),
  is_blocked INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_analysis_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  session_type TEXT NOT NULL CHECK (session_type IN ('guest', 'admin')),
  admin_id TEXT REFERENCES admins(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (
    (session_type = 'guest' AND admin_id IS NULL AND device_id IS NOT NULL)
    OR
    (session_type = 'admin' AND admin_id IS NOT NULL AND device_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS activation_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 3650),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'revoked')),
  created_by_admin_id TEXT NOT NULL REFERENCES admins(id),
  created_at INTEGER NOT NULL,
  redeemed_by_device_id TEXT REFERENCES devices(id),
  redeemed_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  activation_code_id TEXT UNIQUE REFERENCES activation_codes(id),
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK (outcome IN ('reserved', 'succeeded', 'failed', 'released')),
  provider TEXT,
  model TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_expiry
  ON sessions(token_hash, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_device
  ON sessions(device_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_device_expiry
  ON subscriptions(device_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_activation_codes_status
  ON activation_codes(status, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_device_created
  ON usage_events(device_id, created_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  id TEXT PRIMARY KEY,
  identity_hash TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_identity_time
  ON auth_attempts(identity_hash, created_at);
