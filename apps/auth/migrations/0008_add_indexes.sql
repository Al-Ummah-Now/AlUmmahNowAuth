-- Migration: Add performance indexes to user and logs tables
-- Created: 2025-10-12
-- Description: Adds database indexes to improve query performance for common access patterns

-- Index on user.email for faster lookups during authentication
-- Email is frequently queried during login and user retrieval operations
CREATE INDEX IF NOT EXISTS idx_user_email ON user(email);

-- Index on user.role for filtering users by role
-- Used by admin dashboards and role-based access control queries
CREATE INDEX IF NOT EXISTS idx_user_role ON user(role);

-- Index on logs.timestamp for time-based queries
-- Already exists from 0006_create_logs_table.sql, but included here for completeness
-- CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);

-- Index on logs.level for filtering by log severity
-- Already exists from 0006_create_logs_table.sql, but included here for completeness
-- CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

-- Note: The logs table indexes (idx_logs_timestamp and idx_logs_level) were already
-- created in migration 0006_create_logs_table.sql, so they are commented out here
-- to avoid "index already exists" errors.
