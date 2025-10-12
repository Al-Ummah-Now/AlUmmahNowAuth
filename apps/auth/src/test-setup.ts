// Test setup file - runs before all tests
import { env } from "cloudflare:test";

// Create the user table schema for testing
export async function setupDatabase() {
  // Migration 0001: Create user table
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      role TEXT DEFAULT 'user',
      password_reset_required BOOLEAN DEFAULT FALSE
    )
  `).run();
}

// Run setup automatically when this module is imported
await setupDatabase();
