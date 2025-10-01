-- Migration number: 0005 	 2025-09-30T00:00:00.000Z
INSERT INTO clients (
  client_id,
  redirect_uri,
  theme_title,
  theme_primary,
  theme_favicon,
  theme_logo_dark,
  theme_logo_light
) VALUES (
  'admin-dashboard',
  'https://al-ummah-now-auth-admin.alummahnow.workers.dev/auth/callback',
  'Admin Dashboard',
  '#0ea5e9',
  'https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico',
  'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png',
  'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png'
);
