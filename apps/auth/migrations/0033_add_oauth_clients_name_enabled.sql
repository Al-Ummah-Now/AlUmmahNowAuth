-- Migration number: 0033
-- Description: Add name and enabled columns to oauth_clients table
-- Date: 2025-12-02T00:00:00.000Z

-- Add name column (display name for the client)
ALTER TABLE oauth_clients ADD COLUMN name TEXT;

-- Add enabled column (for disabling clients without deleting)
ALTER TABLE oauth_clients ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;

-- Update existing clients with names
UPDATE oauth_clients SET name = 'Profile App' WHERE id = 'profile-app-id';
UPDATE oauth_clients SET name = 'Admin Dashboard' WHERE id = 'admin-dashboard-id';

-- Create index for enabled status lookups
CREATE INDEX IF NOT EXISTS idx_oauth_clients_enabled ON oauth_clients(enabled);
