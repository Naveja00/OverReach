-- Run once: wrangler d1 execute overreach-telemetry --file=schema.sql
CREATE TABLE IF NOT EXISTS inits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  node_version TEXT NOT NULL,
  vendors INTEGER NOT NULL DEFAULT 0,
  overreach_version TEXT NOT NULL,
  client_ts TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inits_received ON inits(received_at);
CREATE INDEX IF NOT EXISTS idx_inits_version ON inits(overreach_version);
