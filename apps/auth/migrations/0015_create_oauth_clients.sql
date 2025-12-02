-- Migration number: 0015 	 2025-01-19T00:00:00.000Z
-- Create OAuth 2.0 clients table for confidential client authentication
-- This table stores OAuth 2.0 client credentials and configuration
-- Implements RFC 6749 Section 2.3 (Client Authentication)

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT UNIQUE NOT NULL,
  client_secret_hash TEXT,
  client_type TEXT NOT NULL CHECK(client_type IN ('public', 'confidential')),
  allowed_grants TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_oauth_clients_client_id ON oauth_clients(client_id);
