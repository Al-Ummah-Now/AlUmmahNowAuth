# OpenAuth Bug Report: CloudflareStorage TTL Calculation Causes KV PUT Failures

## Bug Summary

The `CloudflareStorage` implementation in `@openauthjs/openauth@0.4.3` has a timing bug that causes KV PUT operations to fail with "Invalid expiration_ttl of 59. Expiration TTL must be at least 60".

## Affected File

`node_modules/@openauthjs/openauth/dist/esm/storage/cloudflare.js` (and corresponding source file)

## Root Cause

The `set()` method calculates TTL using `Math.floor()` which loses fractional seconds:

```javascript
async set(key, value, expiry) {
  await options.namespace.put(joinKey(key), JSON.stringify(value), {
    expirationTtl: expiry ? Math.floor((expiry.getTime() - Date.now()) / 1000) : undefined
  });
}
```

**The Problem:**
1. OpenAuth calculates `expiry` as `Date.now() + 60000` (60 seconds from now)
2. During async execution, a few hundred milliseconds pass
3. By the time KV PUT executes: `(expiry.getTime() - Date.now()) / 1000` = ~59.5 seconds
4. `Math.floor(59.5)` = 59
5. Cloudflare KV rejects with: `KV PUT failed: 400 Invalid expiration_ttl of 59. Expiration TTL must be at least 60`

This is a **race condition** - the bug occurs intermittently based on execution timing.

## Impact

- **Critical**: All authentication flows fail when this occurs
- Affects production systems using Cloudflare Workers + KV
- Causes cascading failures in dependent services
- Intermittent failures make debugging difficult

## Error Message

```
Error: KV PUT failed: 400 Invalid expiration_ttl of 59. Expiration TTL must be at least 60
```

## Reproduction

The bug manifests when:
1. Using `@openauthjs/openauth` with Cloudflare Workers
2. Using `CloudflareStorage` with KV namespace
3. Running authentication flows (especially under load or in parallel tests)
4. Timing delays between TTL calculation and KV PUT execution

## Proposed Fix

Replace `Math.floor()` with `Math.ceil()` and enforce minimum 60 seconds:

```javascript
async set(key, value, expiry) {
  const ttl = expiry
    ? Math.max(60, Math.ceil((expiry.getTime() - Date.now()) / 1000))
    : undefined;

  await options.namespace.put(joinKey(key), JSON.stringify(value), {
    expirationTtl: ttl
  });
}
```

**Why this works:**
- `Math.ceil()` rounds UP fractional seconds (59.5 → 60)
- `Math.max(60, ...)` enforces Cloudflare KV minimum requirement
- Prevents race condition regardless of execution delays

## Workaround

Created a patched version in our codebase:

```typescript
// apps/auth/src/storage/cloudflare-patched.ts
import { joinKey, splitKey } from "@openauthjs/openauth/storage/storage";

export function CloudflarePatchedStorage(options: { namespace: KVNamespace }) {
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
```

## Testing

Confirmed fix eliminates TTL errors:
- **Before**: 25/44 E2E tests failed with TTL errors
- **After**: 0 TTL errors across all test runs

## Environment

- OpenAuth version: `0.4.3`
- Platform: Cloudflare Workers
- Storage: Cloudflare KV
- Node version: 20.x
- Package manager: pnpm 9.0.0

## Additional Notes

This bug is particularly problematic because:
1. It's intermittent (timing-dependent)
2. It affects critical authentication paths
3. Error message doesn't clearly indicate the root cause
4. Impacts production reliability

## Request

Please update `CloudflareStorage` to use the proposed fix to prevent this timing race condition.

Happy to submit a PR if that would be helpful!

---

**Reported by**: Al Ummah Now Auth System Team
**Date**: 2025-10-18
**OpenAuth Version**: 0.4.3
