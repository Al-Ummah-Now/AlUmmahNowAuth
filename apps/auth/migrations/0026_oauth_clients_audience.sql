-- Migration: 0026_oauth_clients_audience
-- Description: Add audience field to oauth_clients for audience-specific tokens
-- Each client can have its own audience identifier used in JWT aud claim

-- Add audience field to oauth_clients
ALTER TABLE oauth_clients ADD COLUMN audience TEXT;

-- Update existing clients to use client_id as default audience
-- This maintains backward compatibility
UPDATE oauth_clients SET audience = id WHERE audience IS NULL;

-- Create index for efficient audience lookups
CREATE INDEX IF NOT EXISTS idx_oauth_clients_audience ON oauth_clients(audience);
