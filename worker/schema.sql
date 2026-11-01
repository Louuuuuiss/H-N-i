CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);

