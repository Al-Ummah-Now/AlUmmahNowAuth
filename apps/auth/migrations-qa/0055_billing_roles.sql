-- Migration: 0055_billing_roles
-- Description: Assignable billing roles for Plans & Entitlements. The billing app
-- authorizes access using the role names in the token, as it does for reviewers.
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES
  ('role_billing_admin', 'Billing Admin', 'default', 'Manage plans, assignments and overrides', 0, unixepoch() * 1000, unixepoch() * 1000),
  ('role_billing_viewer', 'Billing Viewer', 'default', 'View plans, assignments and overrides', 0, unixepoch() * 1000, unixepoch() * 1000);
