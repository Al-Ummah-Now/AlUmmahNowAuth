/**
 * Patches the generated wrangler.json in build/server with QA environment settings
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildConfigPath = join(__dirname, '../build/server/wrangler.json');

// Remove conflicting deploy config if it exists
const deployConfigPath = join(__dirname, '../.wrangler/deploy');
if (existsSync(deployConfigPath)) {
  rmSync(deployConfigPath, { recursive: true, force: true });
  console.log('🗑️  Removed conflicting .wrangler/deploy directory');
}

// Read the generated config
const config = JSON.parse(readFileSync(buildConfigPath, 'utf-8'));

// Apply QA overrides
config.name = 'al-ummah-now-auth-admin-qa';
config.vars = {
  AUTH_SERVER_URL: 'https://auth.qa.alummahnow.net',
  APP_URL: 'https://admin.auth.qa.alummahnow.net'
};
config.kv_namespaces = [
  {
    binding: 'AUTH_STORAGE',
    id: '14fd32ab385b496c88b5dba88c2492ea'
  }
];
// D1 database binding removed - admin app now uses auth server APIs

// Patch routes for QA domain
config.routes = [
  {
    pattern: 'admin.auth.qa.alummahnow.net',
    zone_name: 'alummahnow.net',
    custom_domain: true
  }
];

// Remove production-specific fields
delete config.configPath;
delete config.userConfigPath;
delete config.topLevelName;

// Write the patched config
writeFileSync(buildConfigPath, JSON.stringify(config, null, 2));

console.log('✅ Patched build/server/wrangler.json for QA environment');
