#!/usr/bin/env node

/**
 * Verify that ERROR logs are being saved to D1
 */

const { execSync } = require('child_process');

console.log('🔍 Checking D1 for ERROR logs...\n');

try {
  // Check all logs by service
  console.log('📊 Logs by service and level:');
  const result = execSync(
    'wrangler d1 execute AUTH_DB --local --command="SELECT service, level, COUNT(*) as count FROM logs GROUP BY service, level ORDER BY service, level" --config apps/auth/wrangler.json',
    { encoding: 'utf-8', cwd: process.cwd() }
  );
  console.log(result);
  
  // Check specifically for ADMIN ERROR logs
  console.log('\n🔴 ADMIN ERROR logs:');
  const adminErrors = execSync(
    'wrangler d1 execute AUTH_DB --local --command="SELECT COUNT(*) as error_count FROM logs WHERE service=\'ADMIN\' AND level=\'ERROR\'" --config apps/auth/wrangler.json',
    { encoding: 'utf-8', cwd: process.cwd() }
  );
  console.log(adminErrors);
  
  if (adminErrors.includes('error_count') && !adminErrors.includes('│ 0')) {
    console.log('\n✅ SUCCESS! ADMIN ERROR logs are being saved to D1!\n');
    
    // Show sample ERROR logs
    console.log('📝 Sample ADMIN ERROR logs:');
    const samples = execSync(
      'wrangler d1 execute AUTH_DB --local --command="SELECT timestamp, message FROM logs WHERE service=\'ADMIN\' AND level=\'ERROR\' ORDER BY timestamp DESC LIMIT 3" --config apps/auth/wrangler.json',
      { encoding: 'utf-8', cwd: process.cwd() }
    );
    console.log(samples);
  } else {
    console.log('\n⚠️  No ADMIN ERROR logs found.');
    console.log('   Make sure you:');
    console.log('   1. Ran pnpm dev (both apps as Workers)');
    console.log('   2. Triggered errors in the admin app');
    console.log('   3. Waited a moment for logs to persist\n');
  }
  
  // Check AUTH ERROR logs too
  console.log('\n🔴 AUTH ERROR logs:');
  const authErrors = execSync(
    'wrangler d1 execute AUTH_DB --local --command="SELECT COUNT(*) as error_count FROM logs WHERE service=\'AUTH\' AND level=\'ERROR\'" --config apps/auth/wrangler.json',
    { encoding: 'utf-8', cwd: process.cwd() }
  );
  console.log(authErrors);
  
} catch (error) {
  console.error('❌ Failed to check logs:', error.message);
  process.exit(1);
}
