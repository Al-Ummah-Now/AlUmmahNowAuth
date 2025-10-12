# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

The Al Ummah Now team takes security vulnerabilities seriously. We appreciate your efforts to responsibly disclose your findings.

### How to Report

**Do NOT create a public GitHub issue for security vulnerabilities.**

Instead, please report security vulnerabilities to:

**Email:** security@alummahnow.net

### What to Include

To help us triage and respond to your report effectively, please include:

1. **Description** - A clear description of the vulnerability
2. **Impact** - Potential impact and attack scenario
3. **Reproduction Steps** - Detailed steps to reproduce the issue
4. **Proof of Concept** - Code, screenshots, or logs demonstrating the vulnerability
5. **Environment** - Version, configuration, and environment details
6. **Suggested Fix** - If you have recommendations (optional)

### Example Report

```
Subject: [SECURITY] Authentication Bypass in OAuth Flow

Description:
An attacker can bypass authentication by manipulating the OAuth state parameter.

Impact:
- Unauthorized access to user accounts
- Potential data breach
- Session hijacking

Reproduction Steps:
1. Navigate to /authorize endpoint
2. Capture the state parameter
3. Modify the state value to: [example]
4. Complete the OAuth flow
5. Access is granted without proper authentication

Proof of Concept:
[Attach screenshots or code]

Environment:
- Version: 1.0.0
- Deployment: Production (Cloudflare Workers)
- Browser: Chrome 120

Suggested Fix:
Implement cryptographic signing of state parameters using HMAC-SHA256.
```

## Response Timeline

We are committed to responding quickly to security reports:

| Timeline | Action |
|----------|--------|
| **24 hours** | Initial acknowledgment of your report |
| **72 hours** | Preliminary assessment and severity classification |
| **7 days** | Detailed response with remediation plan |
| **30 days** | Security patch released (for critical issues) |

For critical vulnerabilities, we will expedite the fix and release process.

## Severity Classification

We use the following severity levels:

### Critical
- Remote code execution
- Authentication bypass
- Privilege escalation to admin
- Mass data exposure

### High
- SQL injection
- Cross-site scripting (XSS)
- Session hijacking
- Sensitive data exposure

### Medium
- Cross-site request forgery (CSRF)
- Information disclosure
- Denial of service (DoS)

### Low
- Minor information leaks
- Configuration issues
- Non-security bugs with security implications

## Security Measures

Our authentication system implements multiple security layers:

### Authentication & Authorization

- **OAuth 2.0** - Industry-standard authentication protocol
- **Email-based passwordless login** - No password storage, reduces attack surface
- **Time-limited codes** - Login codes expire after a short period
- **Role-based access control (RBAC)** - Admin and user roles with proper authorization checks

### Session Management

- **Secure cookies** - HttpOnly, Secure (production), SameSite=Lax
- **Session expiration** - 7-day TTL with automatic cleanup
- **Token validation** - Access tokens verified on each request
- **Logout functionality** - Proper session cleanup on logout

### Data Protection

- **KV encryption at rest** - Cloudflare KV encrypts data by default
- **D1 encryption at rest** - Database data encrypted
- **TLS/HTTPS only** - All traffic encrypted in production
- **No password storage** - Passwordless authentication eliminates credential theft

### Input Validation

- **Email validation** - Using valibot schema validation
- **SQL injection prevention** - Parameterized queries with D1 prepared statements
- **Request validation** - Input sanitization and type checking

### Infrastructure Security

- **Cloudflare Workers** - Isolated execution environments
- **Edge deployment** - DDoS protection and rate limiting
- **Observability** - Request logging for security monitoring
- **Environment isolation** - Separate preview and production environments

## Security Best Practices for Users

### For Administrators

1. **Limit admin access** - Only grant admin role to trusted users
2. **Monitor logs** - Regularly review logs at `/logs` endpoint
3. **Rotate secrets** - Update API keys periodically (RESEND_API_KEY)
4. **Review user list** - Audit user accounts regularly
5. **Enable observability** - Use Cloudflare's observability features

### For Developers

1. **Keep dependencies updated** - Run `pnpm update` regularly
2. **Use environment variables** - Never commit secrets to git
3. **Test locally first** - Use preview deployments before production
4. **Review changes** - Audit code changes before merging
5. **Follow least privilege** - Use appropriate role permissions

### For OAuth Clients

1. **Validate redirect URIs** - Ensure proper redirect_uri configuration
2. **Use HTTPS only** - Never use HTTP in production
3. **Implement CSRF protection** - Use state parameter properly
4. **Store tokens securely** - HttpOnly cookies or secure storage
5. **Handle errors gracefully** - Don't expose sensitive error details

## Known Security Considerations

### OAuth 2.0 Limitations

- **No PKCE support yet** - Public clients should wait for PKCE implementation
- **No refresh token rotation** - Refresh tokens are currently long-lived
- **No rate limiting on auth endpoints** - DDoS protection relies on Cloudflare

### Cloudflare Workers Constraints

- **No filesystem access** - Secrets must be in environment variables
- **Request timeout** - 30-second CPU time limit
- **No background jobs** - Long-running tasks not supported

### Planned Security Enhancements

- [ ] Implement PKCE (Proof Key for Code Exchange)
- [ ] Add refresh token rotation
- [ ] Rate limiting on authentication endpoints
- [ ] Multi-factor authentication (MFA)
- [ ] Audit log for admin actions
- [ ] Account lockout after failed attempts
- [ ] IP-based access control

## Security Updates

We will notify users of security updates through:

1. **GitHub Releases** - Security patches tagged with [SECURITY]
2. **Email notifications** - For critical vulnerabilities
3. **Changelog** - SECURITY.md updates section

## Acknowledgments

We appreciate security researchers who help improve our security posture. With your permission, we will acknowledge your contribution in our security advisories.

Thank you for helping keep Al Ummah Now secure!

---

**Last Updated:** October 12, 2025

**Contact:** security@alummahnow.net
