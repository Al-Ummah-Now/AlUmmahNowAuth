-- Migration: 0010_web_locale_redirect_uris
-- The auth server now checks /authorize against oauth_clients and matches
-- redirect_uri exactly (full string, query included; OAuth 2.1). The web app
-- (Next.js) sends /api/callback?locale=en|ar, so register both variants next
-- to the plain callback and the multi-account callback. The full list is
-- written so the result is the same however the row looked before.
UPDATE oauth_clients
SET redirect_uris = '["http://localhost:3001/api/callback","http://localhost:3001/api/callback?locale=en","http://localhost:3001/api/callback?locale=ar","http://localhost:3001/api/callback/multi-account","https://videos.alummahnow.net/api/callback","https://videos.alummahnow.net/api/callback?locale=en","https://videos.alummahnow.net/api/callback?locale=ar","https://videos.alummahnow.net/api/callback/multi-account"]',
    updated_at = unixepoch() * 1000
WHERE id = 'f0de3c30-0304-4ac4-86d6-1e185dec0439';
