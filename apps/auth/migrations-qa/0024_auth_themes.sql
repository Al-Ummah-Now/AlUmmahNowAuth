-- Migration: 0024_auth_themes
-- Auth's own themes, managed in the Auth admin (expand-only: new tables).
-- Packages (theme.json + files) live in the AUTH_THEMES KV namespace under
-- their content hash; these tables say which package is each custom theme's
-- draft and which is published, and which theme Auth and each client use.
-- Built-in themes are bundled with the worker and have no row.
CREATE TABLE IF NOT EXISTS auth_themes (
  id TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  draft_key TEXT,
  draft_version TEXT,
  published_key TEXT,
  published_version TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- key 'default_theme': the theme every page gets unless the client has its own
CREATE TABLE IF NOT EXISTS auth_theme_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS auth_theme_client_defaults (
  client_id TEXT PRIMARY KEY,
  theme_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
