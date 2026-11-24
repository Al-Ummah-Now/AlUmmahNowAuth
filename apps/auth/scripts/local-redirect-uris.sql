-- LOCAL DEVELOPMENT ONLY (pnpm migrations:local): the http://localhost redirect URIs of the apps run on this
-- machine, which migrations/0051 leaves out. Never run against a deployed database. Idempotent.
WITH local(id, uri) AS (
  VALUES
    ('109a1087-6626-40f7-8a7f-7f42f83f4f30', 'http://localhost:3302/callback'),
    ('1448ed27-39a6-417d-b4c8-07f881e81269', 'http://localhost:3303/auth/callback'),
    ('1448ed27-39a6-417d-b4c8-07f881e81269', 'http://localhost:5175/auth/callback'),
    ('f0de3c30-0304-4ac4-86d6-1e185dec0439', 'http://localhost:3001/api/callback'),
    ('f0de3c30-0304-4ac4-86d6-1e185dec0439', 'http://localhost:3001/api/callback?locale=en'),
    ('f0de3c30-0304-4ac4-86d6-1e185dec0439', 'http://localhost:3001/api/callback?locale=ar'),
    ('f0de3c30-0304-4ac4-86d6-1e185dec0439', 'http://localhost:3001/api/callback/multi-account'),
    ('a24e39de-601d-463b-b50d-37a0a94e986b', 'http://localhost:3091/api/callback')
)
UPDATE oauth_clients
SET redirect_uris = (
      SELECT json_group_array(value) FROM (
        SELECT value FROM json_each(oauth_clients.redirect_uris)
        UNION
        SELECT uri FROM local WHERE local.id = oauth_clients.id
      )
    ),
    updated_at = unixepoch() * 1000
WHERE id IN (SELECT id FROM local) AND CASE WHEN json_valid(redirect_uris) THEN json_type(redirect_uris) END = 'array';
