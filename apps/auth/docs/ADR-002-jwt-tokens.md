# ADR-002: JWT Access Tokens with Refresh Token Rotation

## Status
Proposed

## Context
The Al Ummah Now authentication system currently uses OpenAuth for passwordless email authentication. However, the token management strategy needs improvement to align with OAuth 2.0/OIDC standards and provide better security through refresh token rotation.

### Current State Analysis
1. **OpenAuth Integration**: The system uses OpenAuth's built-in JWT generation
2. **Session Storage**: Sessions stored in KV with 7-day expiration
3. **No Refresh Token Rotation**: Current tokens don't rotate on use
4. **Limited Token Validation**: Basic JWT verification without comprehensive claims validation
5. **No Token Revocation**: No mechanism to revoke compromised tokens

### Requirements
- Stateless JWT access tokens for API authentication
- Refresh token rotation for enhanced security
- Token revocation capability
- Compliance with OAuth 2.0 / OIDC standards
- Seamless integration with existing OpenAuth system
- Support for cross-domain authentication (auth.alummahnow.net, profile.auth.alummahnow.net)

## Decision

### Token Architecture

#### 1. Dual Token System
- **Access Tokens**: Short-lived JWTs (15 minutes)
- **Refresh Tokens**: Long-lived opaque tokens (7 days) with rotation

#### 2. Token Format

**Access Token (JWT) Claims:**
```json
{
  "iss": "https://auth.alummahnow.net",
  "sub": "user_id_here",
  "aud": ["https://api.alummahnow.net"],
  "exp": 1234567890,
  "iat": 1234567800,
  "nbf": 1234567800,
  "jti": "unique_token_id",
  "email": "user@example.com",
  "role": "user|admin",
  "client_id": "profile-app",
  "scope": "openid email profile"
}
```

**Refresh Token Storage (D1):**
```sql
CREATE TABLE refresh_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    token_hash TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    ip_address TEXT,
    user_agent TEXT,
    revoked BOOLEAN DEFAULT FALSE,
    revoked_at INTEGER,
    revoked_reason TEXT,
    parent_token_id TEXT,
    rotation_count INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_token_hash (token_hash),
    INDEX idx_expires_at (expires_at)
);
```

#### 3. Signing Strategy
- **Algorithm**: RS256 (RSA with SHA-256)
- **Key Management**: Store keys in Cloudflare KV with rotation
- **Key Rotation**: Quarterly with overlap period

**Key Storage Structure:**
```javascript
// KV Keys
"jwt:current_kid" -> "key_2025_q1"
"jwt:keys:key_2025_q1" -> { privateKey, publicKey, created, expires }
"jwt:keys:key_2024_q4" -> { privateKey, publicKey, created, expires } // Previous for validation
```

#### 4. Token Lifecycle

**Initial Authentication Flow:**
1. User authenticates via OpenAuth passwordless email
2. System generates access token (15 min) and refresh token (7 days)
3. Refresh token stored in D1 with metadata
4. Both tokens returned to client

**Token Refresh Flow:**
1. Client presents expired access token + valid refresh token
2. System validates refresh token in D1
3. Generates new access token
4. Rotates refresh token (invalidates old, creates new)
5. Updates rotation_count and parent_token_id
6. Returns new token pair

**Rotation Security:**
- Grace period: 2 minutes for race conditions
- Maximum rotation count: 100 (prevents infinite chains)
- Automatic revocation of entire chain on suspicious activity

## Implementation Architecture

### Component Design

#### 1. Token Service (`/apps/auth/src/services/token-service.ts`)
```typescript
interface TokenService {
  // Generate tokens
  generateAccessToken(user: User, clientId: string): Promise<string>
  generateRefreshToken(userId: string, clientId: string): Promise<string>

  // Validate tokens
  verifyAccessToken(token: string): Promise<AccessTokenPayload>
  validateRefreshToken(token: string): Promise<RefreshTokenRecord>

  // Refresh flow
  refreshTokenPair(refreshToken: string): Promise<TokenPair>

  // Revocation
  revokeRefreshToken(token: string, reason: string): Promise<void>
  revokeAllUserTokens(userId: string): Promise<void>
}
```

#### 2. Key Management (`/apps/auth/src/services/key-service.ts`)
```typescript
interface KeyService {
  getCurrentSigningKey(): Promise<SigningKey>
  getValidationKeys(): Promise<SigningKey[]>
  rotateKeys(): Promise<void>
  getJWKS(): Promise<JWKS> // For OIDC discovery
}
```

#### 3. API Endpoints

**Token Endpoint** (`POST /token`):
```typescript
// Request
{
  grant_type: "authorization_code" | "refresh_token",
  code?: string,
  refresh_token?: string,
  client_id: string,
  redirect_uri?: string
}

// Response
{
  access_token: string,
  token_type: "Bearer",
  expires_in: 900,
  refresh_token: string,
  scope: string
}
```

**Introspection Endpoint** (`POST /introspect`):
```typescript
// Request
{
  token: string,
  token_type_hint?: "access_token" | "refresh_token"
}

// Response
{
  active: boolean,
  scope?: string,
  client_id?: string,
  username?: string,
  exp?: number
}
```

**Revocation Endpoint** (`POST /revoke`):
```typescript
// Request
{
  token: string,
  token_type_hint?: "access_token" | "refresh_token"
}
```

### Security Measures

1. **Refresh Token Security**
   - Stored as SHA-256 hash in database
   - Bound to client_id and user_id
   - IP/User-Agent tracking for anomaly detection
   - Automatic revocation on suspicious patterns

2. **Access Token Security**
   - Short expiration (15 minutes)
   - Audience validation
   - JTI for replay protection
   - Signature validation with key rotation

3. **Rotation Security**
   - Parent-child token tracking
   - Automatic chain revocation on reuse
   - Grace period for race conditions
   - Maximum rotation depth limit

## Consequences

### Positive
- **Enhanced Security**: Refresh token rotation prevents token replay attacks
- **Standards Compliance**: Full OAuth 2.0/OIDC compatibility
- **Revocation Capability**: Can immediately invalidate compromised tokens
- **Audit Trail**: Complete token lifecycle tracking in D1
- **Scalability**: Stateless access tokens reduce server load
- **Key Rotation**: Regular key rotation improves security posture

### Negative
- **Complexity**: More complex than simple JWT-only approach
  - *Mitigation*: Comprehensive documentation and abstracted service layer
- **Database Dependency**: Refresh tokens require D1 lookups
  - *Mitigation*: Caching strategy for frequently used tokens
- **Client Complexity**: Clients must handle token refresh
  - *Mitigation*: Provide SDK with automatic refresh handling
- **Storage Overhead**: Storing refresh token history
  - *Mitigation*: Periodic cleanup of expired/revoked tokens

## Alternatives Considered

### 1. JWT-Only (No Refresh Tokens)
- **Rejected**: Long-lived JWTs can't be revoked, security risk

### 2. Opaque Tokens Only (No JWT)
- **Rejected**: Every API call requires database lookup, performance impact

### 3. Sliding Session Windows
- **Rejected**: Complex to implement correctly, race condition prone

### 4. HS256 Symmetric Signing
- **Rejected**: RS256 allows public key distribution for verification

## Migration Strategy

### Phase 1: Infrastructure Setup
1. Create refresh_tokens table in D1
2. Generate initial RS256 key pair
3. Store keys in KV namespace

### Phase 2: Token Service Implementation
1. Implement TokenService class
2. Add key rotation logic
3. Create token validation middleware

### Phase 3: API Endpoint Updates
1. Update /authorize endpoint to issue new token format
2. Implement /token endpoint for refresh flow
3. Add /introspect and /revoke endpoints

### Phase 4: Client Migration
1. Update profile app to handle refresh tokens
2. Implement automatic token refresh
3. Add retry logic with exponential backoff

### Phase 5: Cleanup
1. Migrate existing sessions to new token format
2. Set deprecation timeline for old tokens
3. Remove legacy session code

## Monitoring & Observability

### Metrics to Track
- Token generation rate
- Refresh token rotation frequency
- Failed validation attempts
- Revocation events
- Key rotation success
- Token expiration distribution

### Audit Events
- TOKEN_GENERATED
- TOKEN_REFRESHED
- TOKEN_REVOKED
- TOKEN_VALIDATION_FAILED
- KEY_ROTATED
- SUSPICIOUS_ROTATION_DETECTED

## Testing Strategy

### Unit Tests
- Token generation with correct claims
- Signature validation
- Expiration handling
- Refresh token rotation logic

### Integration Tests
- Full authentication flow
- Token refresh with rotation
- Revocation propagation
- Key rotation without downtime

### Security Tests
- Token replay prevention
- Rotation chain attacks
- Race condition handling
- Key compromise scenarios

## References
- [OAuth 2.0 Security Best Practices (RFC 8725)](https://datatracker.ietf.org/doc/html/rfc8725)
- [OAuth 2.0 for Browser-Based Apps (RFC 9207)](https://datatracker.ietf.org/doc/html/rfc9207)
- [JSON Web Token Best Practices (RFC 8725)](https://datatracker.ietf.org/doc/html/rfc8725)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)