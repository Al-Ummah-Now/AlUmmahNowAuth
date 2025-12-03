-- Update default tenant with correct branding from previous UI config
UPDATE tenants SET
    primary_color = '#0891b2',
    logo_url = 'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png',
    favicon_url = 'https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico',
    updated_at = datetime('now')
WHERE id = 'tenant_default';
