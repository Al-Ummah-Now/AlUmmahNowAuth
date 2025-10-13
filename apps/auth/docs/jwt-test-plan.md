# JWT Token Implementation Test Plan

## Test Scope
Comprehensive testing of JWT access tokens with refresh token rotation, including security, performance, and integration testing.

## Test Environment Setup

### Prerequisites
- Cloudflare Workers development environment
- D1 database with migrations applied
- KV namespace configured
- Test user accounts created
- API testing tools (Postman/curl)

### Test Data
```javascript
// Test Users
const testUsers = [
  { email: 'user1@test.com', role: 'user' },
  { email: 'admin@test.com', role: 'admin' },
  { email: 'attacker@test.com', role: 'user' }
];

// Test Clients
const testClients = [
  { id: 'profile-app', name: 'Profile Application' },
  { id: 'web-app', name: 'Web Application' },
  { id: 'admin-dashboard', name: 'Admin Dashboard' }
];
```

## Test Categories

### 1. Unit Tests

#### 1.1 Token Generation Tests
```typescript
describe('Token Generation', () => {
  test('Access token contains required claims', async () => {
    // Test: Generate access token
    // Expected: Token contains iss, sub, aud, exp, iat, nbf, jti, email, role, client_id, scope
    const token = await tokenService.generateAccessToken(user, clientId);
    const decoded = jwt.decode(token);

    expect(decoded).toHaveProperty('iss', 'https://auth.alummahnow.net');
    expect(decoded).toHaveProperty('sub', user.id);
    expect(decoded).toHaveProperty('email', user.email);
    expect(decoded).toHaveProperty('role', user.role);
    expect(decoded).toHaveProperty('client_id', clientId);
    expect(decoded).toHaveProperty('scope');
    expect(decoded.exp - decoded.iat).toBe(900); // 15 minutes
  });

  test('Refresh token is stored correctly', async () => {
    // Test: Generate refresh token
    // Expected: Token hash stored in database with correct metadata
    const token = await tokenService.generateRefreshToken(userId, clientId);
    const hash = await hashToken(token);
    const record = await db.query('SELECT * FROM refresh_tokens WHERE token_hash = ?', [hash]);

    expect(record).toBeDefined();
    expect(record.user_id).toBe(userId);
    expect(record.client_id).toBe(clientId);
    expect(record.expires_at).toBeGreaterThan(Date.now() / 1000);
  });

  test('Token signing uses correct algorithm', async () => {
    // Test: Verify token signature algorithm
    // Expected: RS256 algorithm used
    const token = await tokenService.generateAccessToken(user, clientId);
    const header = jwt.getHeader(token);

    expect(header.alg).toBe('RS256');
    expect(header.kid).toBeDefined();
  });
});
```

#### 1.2 Token Validation Tests
```typescript
describe('Token Validation', () => {
  test('Valid access token passes verification', async () => {
    // Test: Verify valid token
    // Expected: Returns decoded payload
    const token = await tokenService.generateAccessToken(user, clientId);
    const payload = await tokenService.verifyAccessToken(token);

    expect(payload.sub).toBe(user.id);
    expect(payload.email).toBe(user.email);
  });

  test('Expired token fails verification', async () => {
    // Test: Verify expired token
    // Expected: Throws error
    const expiredToken = generateExpiredToken();

    await expect(tokenService.verifyAccessToken(expiredToken))
      .rejects.toThrow('Token expired');
  });

  test('Token with invalid signature fails', async () => {
    // Test: Verify tampered token
    // Expected: Throws error
    const token = await tokenService.generateAccessToken(user, clientId);
    const tampered = token.slice(0, -10) + 'corrupted';

    await expect(tokenService.verifyAccessToken(tampered))
      .rejects.toThrow('Invalid signature');
  });

  test('Refresh token validation checks revocation', async () => {
    // Test: Validate revoked refresh token
    // Expected: Returns null
    const token = await tokenService.generateRefreshToken(userId, clientId);
    await tokenService.revokeRefreshToken(token, 'Test');

    const validated = await tokenService.validateRefreshToken(token);
    expect(validated).toBeNull();
  });
});
```

#### 1.3 Token Rotation Tests
```typescript
describe('Token Rotation', () => {
  test('Successful rotation generates new pair', async () => {
    // Test: Refresh token rotation
    // Expected: New access and refresh tokens generated
    const initialRefresh = await tokenService.generateRefreshToken(userId, clientId);
    await sleep(3000); // Wait past grace period

    const newPair = await tokenService.refreshTokenPair(initialRefresh);

    expect(newPair.access_token).toBeDefined();
    expect(newPair.refresh_token).toBeDefined();
    expect(newPair.refresh_token).not.toBe(initialRefresh);
  });

  test('Rotation within grace period returns same token', async () => {
    // Test: Multiple refreshes within grace period
    // Expected: Same refresh token returned
    const initialRefresh = await tokenService.generateRefreshToken(userId, clientId);

    const pair1 = await tokenService.refreshTokenPair(initialRefresh);
    const pair2 = await tokenService.refreshTokenPair(initialRefresh);

    expect(pair1.refresh_token).toBe(initialRefresh);
    expect(pair2.refresh_token).toBe(initialRefresh);
  });

  test('Rotation count increments correctly', async () => {
    // Test: Track rotation count
    // Expected: Count increases with each rotation
    let token = await tokenService.generateRefreshToken(userId, clientId);

    for (let i = 1; i <= 3; i++) {
      await sleep(3000);
      const pair = await tokenService.refreshTokenPair(token);
      token = pair.refresh_token;

      const record = await getTokenRecord(token);
      expect(record.rotation_count).toBe(i);
    }
  });

  test('Maximum rotation count prevents infinite chains', async () => {
    // Test: Exceed maximum rotation count
    // Expected: Error thrown at limit
    let token = await tokenService.generateRefreshToken(userId, clientId);

    // Set rotation count to 99
    await db.update('refresh_tokens', { rotation_count: 99 }, { token_hash: hashToken(token) });

    await sleep(3000);
    await expect(tokenService.refreshTokenPair(token))
      .rejects.toThrow('Maximum token rotation count exceeded');
  });
});
```

### 2. Security Tests

#### 2.1 Token Reuse Detection
```typescript
describe('Security - Token Reuse', () => {
  test('Reuse of rotated token revokes entire chain', async () => {
    // Test: Attempt to reuse old refresh token
    // Expected: All tokens in chain revoked
    const token1 = await tokenService.generateRefreshToken(userId, clientId);

    await sleep(3000);
    const pair2 = await tokenService.refreshTokenPair(token1);

    await sleep(3000);
    const pair3 = await tokenService.refreshTokenPair(pair2.refresh_token);

    // Attempt reuse of old token
    await expect(tokenService.refreshTokenPair(token1))
      .rejects.toThrow('Invalid refresh token');

    // Verify entire chain revoked
    expect(await tokenService.validateRefreshToken(pair2.refresh_token)).toBeNull();
    expect(await tokenService.validateRefreshToken(pair3.refresh_token)).toBeNull();
  });

  test('Concurrent refresh attempts handled correctly', async () => {
    // Test: Race condition during refresh
    // Expected: Grace period prevents issues
    const token = await tokenService.generateRefreshToken(userId, clientId);

    // Simulate concurrent requests
    const [result1, result2] = await Promise.all([
      tokenService.refreshTokenPair(token),
      tokenService.refreshTokenPair(token)
    ]);

    expect(result1.refresh_token).toBe(token);
    expect(result2.refresh_token).toBe(token);
  });
});
```

#### 2.2 Token Hijacking Prevention
```typescript
describe('Security - Hijacking Prevention', () => {
  test('IP change detection logs anomaly', async () => {
    // Test: Token used from different IP
    // Expected: Anomaly logged but allowed (user may be mobile)
    const token = await tokenService.generateRefreshToken(userId, clientId, mockRequest('1.2.3.4'));

    await sleep(3000);
    const pair = await tokenService.refreshTokenPair(token, mockRequest('5.6.7.8'));

    const logs = await getAuditLogs();
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'IP_CHANGE_DETECTED',
        user_id: userId
      })
    );
  });

  test('Suspicious pattern triggers security alert', async () => {
    // Test: Rapid IP changes
    // Expected: Security alert triggered
    const token = await tokenService.generateRefreshToken(userId, clientId, mockRequest('1.2.3.4'));

    // Multiple rapid IP changes
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      await tokenService.refreshTokenPair(token, mockRequest(`${i}.${i}.${i}.${i}`));
    }

    const alerts = await getSecurityAlerts();
    expect(alerts).toContainEqual(
      expect.objectContaining({
        type: 'SUSPICIOUS_TOKEN_USAGE',
        user_id: userId
      })
    );
  });
});
```

#### 2.3 Cross-Site Request Forgery (CSRF) Protection
```typescript
describe('Security - CSRF Protection', () => {
  test('Token endpoint requires proper content type', async () => {
    // Test: Request without proper content type
    // Expected: Request rejected
    const response = await fetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ grant_type: 'refresh_token' })
    });

    expect(response.status).toBe(400);
  });

  test('CORS headers properly configured', async () => {
    // Test: Check CORS headers
    // Expected: Correct CORS configuration
    const response = await fetch('/token', {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://evil.com' }
    });

    expect(response.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
  });
});
```

### 3. Integration Tests

#### 3.1 Full Authentication Flow
```typescript
describe('Integration - Auth Flow', () => {
  test('Complete authentication flow', async () => {
    // Test: Full authentication from login to API access
    // Step 1: User login
    const loginResponse = await fetch('/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', code: '123456' })
    });

    expect(loginResponse.status).toBe(200);
    const { access_token, refresh_token } = await loginResponse.json();

    // Step 2: Use access token for API
    const apiResponse = await fetch('/api/profile', {
      headers: { 'Authorization': `Bearer ${access_token}` }
    });

    expect(apiResponse.status).toBe(200);

    // Step 3: Refresh when expired
    await sleep(16 * 60 * 1000); // Wait for expiration

    const refreshResponse = await fetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refresh_token,
        client_id: 'profile-app'
      })
    });

    expect(refreshResponse.status).toBe(200);
    const newTokens = await refreshResponse.json();

    // Step 4: Use new access token
    const apiResponse2 = await fetch('/api/profile', {
      headers: { 'Authorization': `Bearer ${newTokens.access_token}` }
    });

    expect(apiResponse2.status).toBe(200);
  });
});
```

#### 3.2 Multi-Client Support
```typescript
describe('Integration - Multi-Client', () => {
  test('Different clients get separate tokens', async () => {
    // Test: Same user, different clients
    // Expected: Separate refresh tokens per client
    const user = { id: 'user123', email: 'test@example.com', role: 'user' };

    const token1 = await tokenService.generateRefreshToken(user.id, 'profile-app');
    const token2 = await tokenService.generateRefreshToken(user.id, 'web-app');

    expect(token1).not.toBe(token2);

    // Revoking one doesn't affect the other
    await tokenService.revokeRefreshToken(token1, 'Test');

    const validated = await tokenService.validateRefreshToken(token2);
    expect(validated).not.toBeNull();
  });
});
```

### 4. Performance Tests

#### 4.1 Load Testing
```typescript
describe('Performance - Load', () => {
  test('Handle concurrent token generations', async () => {
    // Test: 100 concurrent token generations
    // Expected: All complete within 5 seconds
    const start = Date.now();

    const promises = Array(100).fill(0).map((_, i) =>
      tokenService.generateAccessToken(
        { id: `user${i}`, email: `user${i}@test.com`, role: 'user' },
        'test-client'
      )
    );

    const tokens = await Promise.all(promises);
    const duration = Date.now() - start;

    expect(tokens).toHaveLength(100);
    expect(duration).toBeLessThan(5000);
  });

  test('Token validation performance', async () => {
    // Test: Validate 1000 tokens
    // Expected: Average < 10ms per validation
    const token = await tokenService.generateAccessToken(user, clientId);

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      await tokenService.verifyAccessToken(token);
    }
    const duration = Date.now() - start;

    expect(duration / 1000).toBeLessThan(10);
  });
});
```

#### 4.2 Database Performance
```typescript
describe('Performance - Database', () => {
  test('Efficient token lookup with indexes', async () => {
    // Test: Query performance with large dataset
    // Setup: Insert 10000 refresh tokens
    for (let i = 0; i < 10000; i++) {
      await insertTestRefreshToken(`user${i}`, 'test-client');
    }

    // Test: Lookup by hash
    const start = Date.now();
    const token = await db.query(
      'SELECT * FROM refresh_tokens WHERE token_hash = ?',
      [testHash]
    );
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(50);
  });

  test('Cleanup performance', async () => {
    // Test: Cleanup expired tokens
    // Setup: Insert 5000 expired tokens
    const expiredTime = Math.floor(Date.now() / 1000) - 86400;
    for (let i = 0; i < 5000; i++) {
      await insertTestRefreshToken(`user${i}`, 'test-client', expiredTime);
    }

    // Test: Run cleanup
    const start = Date.now();
    await tokenService.cleanupExpiredTokens();
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(2000);

    const remaining = await db.query('SELECT COUNT(*) FROM refresh_tokens WHERE expires_at < ?', [expiredTime]);
    expect(remaining.count).toBe(0);
  });
});
```

### 5. Error Handling Tests

#### 5.1 Graceful Failure
```typescript
describe('Error Handling', () => {
  test('Database failure handled gracefully', async () => {
    // Test: Database unavailable
    // Expected: Returns appropriate error
    const mockEnv = { AUTH_DB: null };
    const service = new TokenService(mockEnv, storage);

    await expect(service.generateRefreshToken(userId, clientId))
      .rejects.toThrow('Database unavailable');
  });

  test('Invalid token format handled', async () => {
    // Test: Malformed token
    // Expected: Clear error message
    await expect(tokenService.verifyAccessToken('not.a.token'))
      .rejects.toThrow('Invalid token format');
  });

  test('Key rotation failure recovery', async () => {
    // Test: Key rotation fails
    // Expected: Falls back to existing key
    jest.spyOn(keyService, 'generateNewKeyPair').mockRejectedValue(new Error('KV write failed'));

    const key = await keyService.getCurrentSigningKey();
    expect(key).toBeDefined();
  });
});
```

### 6. Compliance Tests

#### 6.1 OAuth 2.0 Compliance
```typescript
describe('OAuth 2.0 Compliance', () => {
  test('Token endpoint follows RFC 6749', async () => {
    // Test: Token endpoint response format
    // Expected: Compliant with OAuth 2.0 spec
    const response = await fetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: validRefreshToken,
        client_id: 'test-client'
      })
    });

    const data = await response.json();

    expect(data).toHaveProperty('access_token');
    expect(data).toHaveProperty('token_type', 'Bearer');
    expect(data).toHaveProperty('expires_in');
    expect(data).toHaveProperty('refresh_token');
    expect(data).toHaveProperty('scope');
  });

  test('Error responses follow RFC 6749', async () => {
    // Test: Invalid grant type
    // Expected: Proper error format
    const response = await fetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'invalid_grant'
      })
    });

    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error).toHaveProperty('error', 'unsupported_grant_type');
  });
});
```

#### 6.2 OIDC Compliance
```typescript
describe('OIDC Compliance', () => {
  test('JWKS endpoint available', async () => {
    // Test: JWKS discovery
    // Expected: Valid JWKS response
    const response = await fetch('/.well-known/jwks.json');

    expect(response.status).toBe(200);
    const jwks = await response.json();

    expect(jwks).toHaveProperty('keys');
    expect(jwks.keys).toBeInstanceOf(Array);
    expect(jwks.keys[0]).toHaveProperty('kty');
    expect(jwks.keys[0]).toHaveProperty('use', 'sig');
    expect(jwks.keys[0]).toHaveProperty('kid');
    expect(jwks.keys[0]).toHaveProperty('alg', 'RS256');
  });

  test('ID token includes OIDC claims', async () => {
    // Test: Token claims
    // Expected: OIDC standard claims present
    const token = await tokenService.generateAccessToken(user, clientId);
    const decoded = jwt.decode(token);

    expect(decoded).toHaveProperty('iss');
    expect(decoded).toHaveProperty('sub');
    expect(decoded).toHaveProperty('aud');
    expect(decoded).toHaveProperty('exp');
    expect(decoded).toHaveProperty('iat');
  });
});
```

## Test Execution Plan

### Phase 1: Unit Testing (Week 1)
- [ ] Set up test environment
- [ ] Run token generation tests
- [ ] Run token validation tests
- [ ] Run token rotation tests
- [ ] Generate unit test coverage report

### Phase 2: Security Testing (Week 2)
- [ ] Run token reuse detection tests
- [ ] Run hijacking prevention tests
- [ ] Run CSRF protection tests
- [ ] Perform penetration testing
- [ ] Document security vulnerabilities

### Phase 3: Integration Testing (Week 3)
- [ ] Test full authentication flow
- [ ] Test multi-client support
- [ ] Test with real OpenAuth integration
- [ ] Test client SDK integration
- [ ] Verify backward compatibility

### Phase 4: Performance Testing (Week 4)
- [ ] Run load tests
- [ ] Run stress tests
- [ ] Measure database query performance
- [ ] Optimize identified bottlenecks
- [ ] Document performance metrics

### Phase 5: Compliance Testing (Week 5)
- [ ] Verify OAuth 2.0 compliance
- [ ] Verify OIDC compliance
- [ ] Run accessibility tests
- [ ] Document compliance status
- [ ] Get security review sign-off

## Test Metrics

### Coverage Targets
- Unit Test Coverage: >= 90%
- Integration Test Coverage: >= 80%
- Security Test Coverage: 100% of identified vectors

### Performance Targets
- Token Generation: < 50ms average
- Token Validation: < 10ms average
- Token Refresh: < 100ms average
- Concurrent Users: Support 1000 concurrent authentications

### Success Criteria
- [ ] All unit tests pass
- [ ] All security tests pass
- [ ] No critical vulnerabilities found
- [ ] Performance targets met
- [ ] OAuth 2.0/OIDC compliance verified
- [ ] Zero data loss during rotation
- [ ] Graceful handling of all error cases

## Test Automation

### CI/CD Pipeline
```yaml
name: JWT Token Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Setup Node.js
        uses: actions/setup-node@v2
      - name: Install dependencies
        run: npm install
      - name: Run unit tests
        run: npm run test:unit
      - name: Run integration tests
        run: npm run test:integration
      - name: Run security tests
        run: npm run test:security
      - name: Generate coverage report
        run: npm run test:coverage
      - name: Upload coverage
        uses: codecov/codecov-action@v1
```

### Monitoring & Alerts
- Monitor token generation failures
- Alert on unusual rotation patterns
- Track validation failure rates
- Monitor database query performance
- Alert on security anomalies

## Risk Mitigation

### Identified Risks
1. **Token Leakage**: Mitigated by short expiration and rotation
2. **Database Failure**: Mitigated by graceful degradation
3. **Key Compromise**: Mitigated by regular rotation
4. **Replay Attacks**: Mitigated by JTI tracking
5. **Performance Degradation**: Mitigated by caching and indexes

### Rollback Plan
1. Keep existing session system operational
2. Feature flag for new token system
3. Gradual rollout to subset of users
4. Monitor error rates and performance
5. One-click rollback if issues detected

## Sign-off Checklist

- [ ] Development team review
- [ ] Security team review
- [ ] Performance benchmarks approved
- [ ] Compliance verification complete
- [ ] Documentation updated
- [ ] Monitoring configured
- [ ] Rollback plan tested
- [ ] Production deployment approved