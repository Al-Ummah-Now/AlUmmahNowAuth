-- Migration: 0051_client_redirect_uris
-- The redirect URIs of production and stage: no http://localhost entries (0004, 0010 and openauth's seed
-- registered some). A local database gets its apps' ones back from scripts/local-redirect-uris.sql. Other
-- entries keep their place, also ones added by hand; a value that is not a JSON array is left as it is. The
-- native apps' http://127.0.0.1 loopback redirects (RFC 8252) are other clients and stay. Idempotent.
UPDATE oauth_clients
SET redirect_uris = (
      SELECT json_group_array(kept.value)
      FROM (
        SELECT u.value AS value FROM json_each(oauth_clients.redirect_uris) AS u
        WHERE NOT (
          lower(u.value) = 'http://localhost' OR lower(u.value) LIKE 'http://localhost:%' OR lower(u.value) LIKE 'http://localhost/%'
          OR lower(u.value) LIKE 'http://localhost?%' OR lower(u.value) LIKE 'http://localhost#%'
        )
        ORDER BY u.key
      ) AS kept
    ),
    updated_at = unixepoch() * 1000
WHERE id IN (
    '109a1087-6626-40f7-8a7f-7f42f83f4f30', -- Auth Profile
    '1448ed27-39a6-417d-b4c8-07f881e81269', -- Auth Admin
    'f0de3c30-0304-4ac4-86d6-1e185dec0439', -- Web
    'a24e39de-601d-463b-b50d-37a0a94e986b', -- Admin Web
    'client_admin_dashboard',               -- example rows of openauth's 002_seed.sql, used by no app
    'client_web_app'
  )
  -- CASE: json_type and json_each fail on text that is not JSON
  AND CASE WHEN json_valid(redirect_uris) THEN json_type(redirect_uris) END = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(oauth_clients.redirect_uris) THEN oauth_clients.redirect_uris ELSE '[]' END) AS u
    WHERE lower(u.value) = 'http://localhost' OR lower(u.value) LIKE 'http://localhost:%' OR lower(u.value) LIKE 'http://localhost/%'
      OR lower(u.value) LIKE 'http://localhost?%' OR lower(u.value) LIKE 'http://localhost#%'
  );
