#!/usr/bin/env node

/**
 * Test script to verify error logging to D1 database
 * 
 * This script:
 * 1. Clears existing logs
 * 2. Runs a test that triggers errors
 * 3. Checks if errors were logged to D1
 */

const { execSync } = require('child_process');

console.log('🧪 Testing Error Logging to D1 Database\n');

// Step 1: Clear existing logs
console.log('1️⃣  Clearing existing logs...');
try {
  execSync(
    'wrangler d1 execute AUTH_DB --local --command="DELETE FROM logs" --config apps/auth/wrangler.json',
    { stdio: 'inherit', cwd: process.cwd() }
  );
  console.log('✅ Logs cleared\n');
} catch (error) {
  console.error('❌ Failed to clear logs:', error.message);
  process.exit(1);
}

// Step 2: Check initial state
console.log('2️⃣  Checking initial state...');
try {
  const result = execSync(
    'wrangler d1 execute AUTH_DB --local --command="SELECT COUNT(*) as count FROM logs" --config apps/auth/wrangler.json',
    { encoding: 'utf-8', cwd: process.cwd() }
  );
  console.log(result);
  console.log('✅ Database is empty\n');
} catch (error) {
  console.error('❌ Failed to check database:', error.message);
  process.exit(1);
}

// Step 3: Instructions for manual testing
console.log('3️⃣  Manual Testing Required:');
console.log('\n📋 Please perform the following steps:');
console.log('   1. Start the auth server: cd apps/auth && pnpm dev');
console.log('   2. Open http://localhost:8787 in your browser');
console.log('   3. Try to login with an invalid email (e.g., test@example.com)');
console.log('   4. Or access the logs endpoint with invalid params: http://localhost:8787/logs?level=invalid');
console.log('   5. Return here and press Enter to check results\n');

// Wait for user input
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

readline.question('Press Enter after performing the test actions...', () => {
  readline.close();
  
  // Step 4: Check logs
  console.log('\n4️⃣  Checking D1 database for logs...');
  try {
    const result = execSync(
      'wrangler d1 execute AUTH_DB --local --command="SELECT level, COUNT(*) as count FROM logs GROUP BY level ORDER BY level" --config apps/auth/wrangler.json',
      { encoding: 'utf-8', cwd: process.cwd() }
    );
    console.log(result);
    
    // Check if ERROR logs exist
    if (result.includes('ERROR')) {
      console.log('\n✅ SUCCESS: ERROR logs are being saved to D1!');
    } else if (result.includes('INFO') || result.includes('DEBUG')) {
      console.log('\n⚠️  WARNING: Some logs saved but no ERROR logs found.');
      console.log('   This might mean no errors occurred during testing.');
      console.log('   Try triggering an actual error (e.g., invalid email send).');
    } else {
      console.log('\n❌ FAILED: No logs found in database!');
      console.log('   The ctx.waitUntil() fix may not be working correctly.');
    }
    
    // Show sample ERROR logs if they exist
    console.log('\n5️⃣  Sample ERROR logs:');
    try {
      const errors = execSync(
        'wrangler d1 execute AUTH_DB --local --command="SELECT timestamp, message, context FROM logs WHERE level=\'ERROR\' ORDER BY timestamp DESC LIMIT 5" --config apps/auth/wrangler.json',
        { encoding: 'utf-8', cwd: process.cwd() }
      );
      console.log(errors);
    } catch (e) {
      console.log('   No ERROR logs found');
    }
    
  } catch (error) {
    console.error('❌ Failed to check logs:', error.message);
    process.exit(1);
  }
});
