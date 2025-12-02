# CORS Wildcard Vulnerability Fix - Issue #79

## Executive Summary

Successfully fixed **CRITICAL (P0)** security vulnerability in the OAuth 2.0 token endpoints by replacing wildcard CORS (`*`) with strict origin whitelisting.

## Problem Statement

The token endpoints at `/token`, `/token/introspect`, and `/token/revoke` used wildcard CORS headers, allowing ANY origin to make authenticated requests. This exposed the authentication system to:

- **Cross-Site Request Forgery (CSRF)** attacks
- **Token theft** via malicious websites
- **Session hijacking** from untrusted origins

## Solution Implemented

### 1. Code Changes

#### File: `apps/auth/src/routes/token-routes.ts`

**Before (Vulnerable):**
```typescript
private static addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*'); // ❌ CRITICAL
  // ...
}

private static corsPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*', // ❌ CRITICAL
      // ...
    },
  });
}
```

**After (Secure):**
```typescript
private static addCorsHeaders(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);

  // Get allowed origins from environment
  const allowedOrigins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()) : [];
  const origin = request.headers.get('Origin');

  // Only allow whitelisted origins
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin'); // ✅ Important for proper caching
  }

  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

private static corsPreflightResponse(request: Request, env: Env): Response {
  const allowedOrigins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()) : [];
  const origin = request.headers.get('Origin');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };

  // Only allow whitelisted origins
  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin'; // ✅ Important for proper caching
  }

  return new Response(null, { status: 204, headers });
}
```

**Method Signature Updates:**
```typescript
// Updated to pass request and env
return this.corsPreflightResponse(request, env);
return this.addCorsHeaders(await this.handleTokenEndpoint(request, env, ctx), request, env);
return this.addCorsHeaders(await this.handleIntrospection(request, env, ctx), request, env);
return this.addCorsHeaders(await this.handleRevocation(request, env, ctx), request, env);
```

### 2. Configuration Changes

#### Production Configuration: `apps/auth/wrangler.json`
```json
{
  "vars": {
    "PROFILE_APP_URL": "https://profile.auth.alummahnow.net/",
    "ALLOWED_ORIGINS": "https://alummah.app,https://admin.alummah.app,https://app.alummah.app",
    "OPENAUTH_ISSUER": "https://auth.alummahnow.net",
    "AUDIT_WEBHOOK_URL": "",
    "AUDIT_WEBHOOK_SECRET": ""
  }
}
```

#### Local Development: `apps/auth/.dev.vars`
```
PROFILE_APP_URL=http://localhost:8788
RESEND_API_KEY=re_Gbo89D5V_8JjVP6irP3zLoyrJsY6HGR1X
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:8788
OPENAUTH_ISSUER=http://localhost:8787
```

#### Type Definitions: `apps/auth/worker-configuration.d.ts`
```typescript
interface Env {
  AUTH_STORAGE: KVNamespace;
  AUDIT_WEBHOOK_URL?: string;
  AUDIT_WEBHOOK_SECRET?: string;
  PROFILE_APP_URL: string;
  RESEND_API_KEY: string;
  ALLOWED_ORIGINS: string;  // ✅ Added
  OPENAUTH_ISSUER: string;
  AUTH_DB: D1Database;
}
```

## Security Benefits

1. **Origin Whitelisting**: Only configured origins can access token endpoints
2. **Vary Header**: Proper caching behavior for CDN/proxies
3. **Zero Wildcards**: No blanket CORS access
4. **Environment-Based**: Easy to configure per deployment environment
5. **Backward Compatible**: Existing routes continue to work

## Testing

### Test Allowed Origin
```bash
curl -X OPTIONS http://localhost:8787/token \
  -H "Origin: http://localhost:3000" \
  -v
```

**Expected Response:**
```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://localhost:3000
Vary: Origin
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

### Test Blocked Origin
```bash
curl -X OPTIONS http://localhost:8787/token \
  -H "Origin: https://evil.com" \
  -v
```

**Expected Response:**
```
HTTP/1.1 204 No Content
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

**Note:** No `Access-Control-Allow-Origin` header = blocked

### Test POST Request
```bash
curl -X POST http://localhost:8787/token \
  -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&client_id=test&refresh_token=xxx" \
  -v
```

## Implementation Pattern

This fix follows the **Hono CORS middleware pattern** as documented in the OpenAuth framework:

```typescript
// Pattern used by OpenAuth
import { cors } from 'hono/cors';

app.use('/api/*', cors({
  origin: (origin, c) => {
    const allowedOrigins = c.env.ALLOWED_ORIGINS.split(',');
    if (allowedOrigins.includes(origin)) {
      return origin;
    }
    return allowedOrigins[0];
  },
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  credentials: true,
}));
```

Our implementation achieves the same security without requiring the Hono CORS middleware dependency.

## Deployment Checklist

- [x] Update code to implement origin whitelisting
- [x] Add `ALLOWED_ORIGINS` to environment configuration
- [x] Update TypeScript type definitions
- [x] Test with allowed origins (localhost for dev)
- [x] Test with blocked origins
- [ ] **Deploy to staging** and test with production-like origins
- [ ] **Deploy to production** with proper origin whitelist
- [ ] Monitor for CORS errors in logs
- [ ] Update production `ALLOWED_ORIGINS` if new apps are added

## Production Deployment Notes

### Current Whitelisted Origins
```
https://alummah.app
https://admin.alummah.app
https://app.alummah.app
```

### Adding New Origins
1. Update `wrangler.json` `vars.ALLOWED_ORIGINS`
2. Redeploy the auth worker: `pnpm --filter auth deploy`
3. No code changes required

### Emergency Rollback
If issues occur:
1. Revert `apps/auth/src/routes/token-routes.ts` to previous version
2. Redeploy: `pnpm --filter auth deploy`

## Related Issues

- **Issue #79**: CORS Wildcard Vulnerability (this fix)
- **Issue #74**: JWT Token Implementation

## References

- [RFC 6749 - OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc6749)
- [MDN: CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- [MDN: Vary Header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Vary)
- [OpenAuth Framework](https://github.com/openauthjs/openauth)
- [OWASP: Cross-Site Request Forgery Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)

## Files Modified

```
apps/auth/src/routes/token-routes.ts     # CORS implementation
apps/auth/wrangler.json                   # Production config
apps/auth/.dev.vars                       # Local config
apps/auth/worker-configuration.d.ts       # TypeScript types
```

## Verification Status

✅ **Code Implementation**: Complete
✅ **Configuration**: Complete
✅ **Type Safety**: Complete
✅ **Documentation**: Complete
⏳ **Production Deployment**: Pending
⏳ **Production Testing**: Pending

---

**Status**: Ready for staging deployment
**Priority**: P0 (Critical Security Fix)
**Estimated Deployment Time**: < 5 minutes
