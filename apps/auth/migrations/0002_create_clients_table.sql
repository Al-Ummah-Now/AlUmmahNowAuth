-- Migration number: 0002 	 2025-04-14T10:04:18.794Z
CREATE TABLE clients (
  client_id TEXT PRIMARY KEY,
  redirect_uri TEXT NOT NULL,
  theme_title TEXT NOT NULL,
  theme_primary TEXT NOT NULL,
  theme_favicon TEXT NOT NULL,
  theme_logo_dark TEXT NOT NULL,
  theme_logo_light TEXT NOT NULL
);