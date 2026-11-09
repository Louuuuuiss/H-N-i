CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);

CREATE TABLE IF NOT EXISTS place_favorites (
  client_hash TEXT NOT NULL,
  place_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_hash, place_id)
);

CREATE INDEX IF NOT EXISTS place_favorites_client_idx ON place_favorites(client_hash);
