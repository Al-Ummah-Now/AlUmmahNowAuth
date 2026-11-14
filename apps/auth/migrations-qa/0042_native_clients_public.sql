-- Migration: 0042_native_clients_public (QA only)
-- The native app clients are PUBLIC (no secret, PKCE only; 0013, 0036, 0039, 0040).
-- `openauth bootstrap-secrets`, run by every QA deploy (qa-e2e.yml), gave each of them a
-- generated secret no one holds before @al-ummah-now/openauth 1.0.54 left native clients
-- out (openauth#48). The native passkey routes admit public native clients only, so on QA
-- they answered invalid_client. Clear those hashes; stage and production never ran it.
-- Keyed by id and metadata.type, so it touches only these rows and is safe to re-run.
UPDATE oauth_clients
SET client_secret_hash = NULL, updated_at = unixepoch() * 1000
WHERE id IN (
  '31389afb-d4f8-4c26-9492-4c77f4d07e65',
  '9c3a81c8-3f9c-4873-abb1-a51e4f1d9543',
  'ce7de8a4-59dd-4682-ab4d-105399105294',
  '45364a42-21f4-4359-a76c-0a1e6615fd7b',
  '29b4792a-caad-4814-a83f-4337bc6a1aeb',
  '77330b47-5747-4058-ba00-921e159f1ced',
  '1c230211-7b90-4d0a-be9d-3068ebd79d5b',
  '306b6f10-d9f0-4609-84a1-23c92da978e9',
  '5b44a4f7-d369-4d12-bc69-028d0276604a'
)
AND json_extract(metadata, '$.type') = 'native'
AND client_secret_hash IS NOT NULL;
