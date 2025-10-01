-- Migration number: 0003 	 2024-12-27T22:30:00.000Z
ALTER TABLE user ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

-- Create an index for role-based queries
CREATE INDEX idx_user_role ON user(role);

-- Set the first user as admin if any users exist
UPDATE user SET role = 'admin' WHERE id = (SELECT id FROM user ORDER BY created_at ASC LIMIT 1);