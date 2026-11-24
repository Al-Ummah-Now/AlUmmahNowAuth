-- Purging a user deletes the tenant invitations it sent, and the foreign key on invited_by is
-- checked on every user delete: both read the whole table without this index.
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_invited_by ON tenant_invitations(invited_by);
