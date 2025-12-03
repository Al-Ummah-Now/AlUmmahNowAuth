-- Migration number: 0032
-- Add name and avatar_url columns to user table for profile display
-- These are optional fields used in multi-account session UIs

ALTER TABLE user ADD COLUMN name TEXT;
ALTER TABLE user ADD COLUMN avatar_url TEXT;

-- Add index for potential future name search
CREATE INDEX IF NOT EXISTS idx_user_name ON user(name);
