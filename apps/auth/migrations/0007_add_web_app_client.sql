-- Add web-app client for the auth app's own UI

-- Local development client
INSERT OR IGNORE INTO clients (
  client_id,
  redirect_uri,
  theme_title,
  theme_primary,
  theme_favicon,
  theme_logo_dark,
  theme_logo_light
) VALUES (
  'web-app',
  'http://localhost:8787/callback',
  'Al Ummah Now',
  '#0ea5e9',
  'https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico',
  'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png',
  'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png'
);

-- Production client
INSERT OR IGNORE INTO clients (
  client_id,
  redirect_uri,
  theme_title,
  theme_primary,
  theme_favicon,
  theme_logo_dark,
  theme_logo_light
) VALUES (
  'web-app-prod',
  'https://auth.alummahnow.net/callback',
  'Al Ummah Now',
  '#0ea5e9',
  'https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico',
  'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png',
  'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png'
);
