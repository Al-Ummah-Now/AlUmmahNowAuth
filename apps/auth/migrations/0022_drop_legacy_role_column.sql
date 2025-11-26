-- Migration: 0022_drop_legacy_role_column.sql
-- Description: Remove the legacy 'role' column from user table
-- The RBAC system (user_roles table) is now the source of truth for roles

-- SQLite doesn't support DROP COLUMN directly in older versions
-- But SQLite 3.35.0+ supports ALTER TABLE DROP COLUMN
-- Cloudflare D1 uses a recent SQLite version that supports this

-- Drop the index on role column first (from migration 0008)
DROP INDEX IF EXISTS idx_user_role;

-- Drop the legacy role column
ALTER TABLE user DROP COLUMN role;
