-- Migration: 0007_fix_profile_redirect_uris
-- Description: Add the Auth Profile OAuth client with correct ID and QA redirect_uri
-- Issue: Profile app uses client_id 109a... but QA seed data created client 209a...
-- The profile app connects with client_id 109a1087-6626-40f7-8a7f-7f42f83f4f30
-- but this client was missing from QA database
-- This migration creates the correct client with both local and QA redirect_uris

-- Insert the Auth Profile client with the correct ID used by the profile app
-- Using INSERT OR REPLACE to handle both cases: new insert or update existing
INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES (
  '109a1087-6626-40f7-8a7f-7f42f83f4f30',
  'default',
  'Auth Profile',
  NULL,
  '["authorization_code","refresh_token"]',
  '["openid","profile","email"]',
  '["http://localhost:3302/callback","https://profile.auth.alummahnow.net/callback","https://profile.auth.qa.alummahnow.net/callback"]',
  '{}',
  1,
  unixepoch() * 1000,
  unixepoch() * 1000
);
