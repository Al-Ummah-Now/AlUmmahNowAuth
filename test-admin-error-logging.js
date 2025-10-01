#!/usr/bin/env node

/**
 * Quick test to verify ERROR logging to D1 works after admin dev mode fix
 */

const { execSync } = require('child_process');

console.log('🧪 Testing ERROR Logging Fix\n');

// Step 1: Clear logs
console.log('1️⃣  Clearing existing logs...');
try {
  execSync(
    'wrangler d1 execute AUTH_DB --local --command="DELETE FROM logs" --config apps/auth/wrangler.json',
    { stdio: 'inherit', cwd: process.cwd() }
  );
  console.log('✅ Logs cleared\n');
} catch (error) {
  console.error('❌ Failed to clear logs');
  process.exit(1);
}

// Step 2: Instructions
console.log('2️⃣  Start the apps:');
console.log('   Run: pnpm dev\n');
console.log('   This will start BOTH apps as Cloudflare Workers:');
console.log('   - Auth: http://localhost:8787');
console.log('   - Admin: http://localhost:5174\n');

console.log('3️⃣  Trigger some errors:');
console.log('   - Visit http://localhost:5174');
console.log('   - Click "Sign In" and complete OAuth flow');
console.log('   - Errors should occur during token verification\n');

console.log('4️⃣  Then run this to check results:');
console.log('   node verify-error-logs.js\n');
