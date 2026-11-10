/**
 * Patched CloudflareStorage for OpenAuth
 *
 * This is a patched version of @al-ummah-now/openauth/storage/cloudflare
 * that fixes a timing bug in TTL calculation.
 *
 * BUG FIX: The original implementation uses Math.floor() which can result
 * in a TTL of 59 seconds when 60 was intended due to timing delays between
 * calculating the expiry and executing the KV PUT operation.
 *
 * Original code:
 *   expirationTtl: expiry ? Math.floor((expiry.getTime() - Date.now()) / 1000) : undefined
 *
 * Fixed code:
 *   expirationTtl: expiry ? Math.max(60, Math.ceil((expiry.getTime() - Date.now()) / 1000)) : undefined
 *
 * Changes:
 * 1. Use Math.ceil() instead of Math.floor() to round up fractional seconds
 * 2. Use Math.max(60, ...) to ensure minimum 60 seconds (Cloudflare KV requirement)
 *
 * TODO: Remove this file once upstream OpenAuth library fixes this issue
 * Issue: https://github.com/openauthjs/openauth/issues/XXX (to be filed)
 */

import { joinKey, splitKey, type AtomicStorageAdapter, type StorageAdapter } from "@al-ummah-now/openauth/storage/storage";

export interface CloudflarePatchedStorageOptions {
  namespace: KVNamespace;
  /**
   * Strongly consistent store for single-use and rotating credentials
   * (D1AtomicStorage). KV alone cannot make them single-use across PoPs.
   */
  atomic?: AtomicStorageAdapter;
  /** Stable name of the store (StorageAdapter.scope) */
  scope?: string;
}

/**
 * Patched CloudflareStorage implementation with fixed TTL calculation
 */
export function CloudflarePatchedStorage(options: CloudflarePatchedStorageOptions): StorageAdapter {
  return {
    ...(options.atomic ? { atomic: options.atomic } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    async get(key: string[]): Promise<Record<string, unknown> | undefined> {
      const value = await options.namespace.get(joinKey(key), "json");
      if (!value) return undefined;
      return value as Record<string, unknown>;
    },

    async set(key: string[], value: unknown, expiry?: Date): Promise<void> {
      // FIX: Use Math.ceil() and Math.max(60, ...) to ensure minimum 60s TTL
      // Also clamp to max 32-bit integer (KV limit) - about 68 years
      const MAX_TTL = 2147483647;
      const ttl = expiry
        ? Math.min(MAX_TTL, Math.max(60, Math.ceil((expiry.getTime() - Date.now()) / 1000)))
        : undefined;

      await options.namespace.put(joinKey(key), JSON.stringify(value), {
        expirationTtl: ttl
      });
    },

    async remove(key: string[]): Promise<void> {
      await options.namespace.delete(joinKey(key));
    },

    async *scan(prefix: string[]): AsyncGenerator<[string[], unknown]> {
      let cursor: string | undefined;
      while (true) {
        const result = await options.namespace.list({
          prefix: joinKey([...prefix, ""]),
          cursor
        });

        for (const key of result.keys) {
          const value = await options.namespace.get(key.name, "json");
          if (value !== null) {
            yield [splitKey(key.name), value] as [string[], unknown];
          }
        }

        if (result.list_complete) {
          break;
        }
        // Type assertion needed because KV list result type is a union
        cursor = (result as { cursor?: string }).cursor;
      }
    }
  };
}
