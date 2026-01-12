-- Migration: 0006_fix_admin_redirect_uris
-- Description: Fix Auth Admin client redirect_uris to use correct /auth/callback path
-- Issue: OAuth authorization fails because admin app uses /auth/callback but DB has /callback

-- Update redirect_uris to match the actual React Router route path
UPDATE oauth_clients SET
  redirect_uris = '["http://localhost:3303/auth/callback","https://admin.auth.qa.alummahnow.net/auth/callback"]'
WHERE id = '2448ed27-39a6-417d-b4c8-07f881e81269';
