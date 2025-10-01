-- Migration number: 0004 	 2025-09-22T13:00:00.000Z
-- Add field to track if password reset is required on first login
ALTER TABLE user ADD COLUMN password_reset_required BOOLEAN NOT NULL DEFAULT FALSE;

-- Create an index for password reset queries
CREATE INDEX idx_user_password_reset_required ON user(password_reset_required);