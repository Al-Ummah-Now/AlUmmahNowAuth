/**
 * Patched CloudflareStorage for OpenAuth
 *
 * This is a patched version of @openauthjs/openauth/storage/cloudflare
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

import { joinKey, splitKey } from "@openauthjs/openauth/storage/storage";

export interface CloudflarePatchedStorageOptions {
  namespace: KVNamespace;
}

/**
 * Patched CloudflareStorage implementation with fixed TTL calculation
 */
export function CloudflarePatchedStorage(options: CloudflarePatchedStorageOptions) {
  return {
    async get(key: string[]) {
      const value = await options.namespace.get(joinKey(key), "json");
      if (!value) return;
      return value;
    },

    async set(key: string[], value: any, expiry?: Date) {
      // FIX: Use Math.ceil() and Math.max(60, ...) to ensure minimum 60s TTL
      const ttl = expiry
        ? Math.max(60, Math.ceil((expiry.getTime() - Date.now()) / 1000))
        : undefined;

      await options.namespace.put(joinKey(key), JSON.stringify(value), {
        expirationTtl: ttl
      });
    },

    async remove(key: string[]) {
      await options.namespace.delete(joinKey(key));
    },

    async* scan(prefix: string[]) {
      let cursor: string | undefined;
      while (true) {
        const result = await options.namespace.list({
          prefix: joinKey([...prefix, ""]),
          cursor
        });

        for (const key of result.keys) {
          const value = await options.namespace.get(key.name, "json");
          if (value !== null) {
            yield [splitKey(key.name), value];
          }
        }

        if (result.list_complete) {
          break;
        }
        cursor = result.cursor;
      }
    }
  };
}
