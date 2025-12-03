-- Migration: 0035_add_openauth_session_fields
-- Description: Add OpenAuth enterprise session fields to account_sessions
-- These fields are required by OpenAuth's SessionService interface for multi-account support

-- Add refresh_token for silent auth capability
-- Note: This stores the actual token (not hash) for OpenAuth compatibility
-- Security: Protected by browser session cookie + D1 access controls
ALTER TABLE account_sessions ADD COLUMN refresh_token TEXT;

-- Add client_id to track which OAuth client the session was created for
ALTER TABLE account_sessions ADD COLUMN client_id TEXT DEFAULT 'profile-app';

-- Add subject_type for OpenAuth subject identification
ALTER TABLE account_sessions ADD COLUMN subject_type TEXT DEFAULT 'user';

-- Add subject_properties as JSON for additional subject data
ALTER TABLE account_sessions ADD COLUMN subject_properties TEXT DEFAULT '{}';

-- Create index for client_id lookups (useful for per-client session management)
CREATE INDEX IF NOT EXISTS idx_account_sessions_client ON account_sessions(client_id);
