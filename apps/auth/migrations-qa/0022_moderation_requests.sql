-- Migration: 0022_moderation_requests
-- Moderation requests from registered client apps (docs/MODERATION_REQUESTS.md).
-- A client app (the videos admin) ASKS auth to act on an identity; only auth
-- admins decide and act. Expand-only: new tables, one new OAuth client, one new
-- RBAC permission granted to the existing Admin and Super Admin roles.

CREATE TABLE IF NOT EXISTS moderation_requests (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL DEFAULT 'default',
	client_id TEXT NOT NULL,
	subject_user_id TEXT NOT NULL,
	action TEXT NOT NULL,
	reason_category TEXT NOT NULL,
	reason TEXT NOT NULL,
	evidence TEXT NOT NULL DEFAULT '[]',
	requested_by_id TEXT NOT NULL,
	requested_by_name TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	payload_hash TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	decision_note TEXT,
	decided_by TEXT,
	decided_at INTEGER,
	actioned_at INTEGER,
	action_result TEXT,
	action_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (client_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_moderation_requests_status ON moderation_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_requests_subject ON moderation_requests(subject_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_requests_client ON moderation_requests(client_id, created_at);

-- Every state change and message on a request, oldest first (the request's history)
CREATE TABLE IF NOT EXISTS moderation_request_events (
	id TEXT PRIMARY KEY,
	request_id TEXT NOT NULL,
	type TEXT NOT NULL,
	actor_type TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	actor_name TEXT,
	note TEXT,
	metadata TEXT,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (request_id) REFERENCES moderation_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_moderation_request_events_request ON moderation_request_events(request_id, created_at);

-- The videos admin's machine client. Confidential: its secret is set per
-- environment with scripts/release/rotate-client-secret.ts (never in a migration).
-- Only clients with the moderation:request scope may file requests.
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('d7464de8-363d-4fc1-b1af-7c71653f0afc', 'default', 'Videos Admin (moderation requests)', NULL, '["client_credentials"]', '["moderation:request"]', '[]', '{"type":"m2m","app":"videos-admin"}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- Auth admin permission to review and decide requests (existing roles only)
INSERT OR IGNORE INTO rbac_permissions (id, name, client_id, description, resource, action, created_at)
SELECT 'perm_admin_moderation_requests', 'moderation_requests:manage', 'client_admin_dashboard',
	'Review and decide moderation requests from client apps', 'moderation_requests', 'manage', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM oauth_clients WHERE id = 'client_admin_dashboard');

INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_id, granted_at, granted_by)
SELECT r.id, 'perm_admin_moderation_requests', unixepoch() * 1000, 'migration:0022'
FROM rbac_roles r
WHERE r.id IN ('role_super_admin', 'role_admin')
	AND EXISTS (SELECT 1 FROM rbac_permissions WHERE id = 'perm_admin_moderation_requests');
