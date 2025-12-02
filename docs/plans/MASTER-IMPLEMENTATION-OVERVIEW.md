# Identity Platform Implementation - Master Overview

## Executive Summary

This document outlines the implementation plan for transforming AlUmmahNow Auth into a full-featured enterprise SSO platform as specified in `docs/IDENTITY_PLATFORM_SPEC.md`.

The implementation is divided into **6 parallel work lanes** that can be executed by multiple agents/developers simultaneously, with clearly defined dependencies.

---

## Current State vs Target State

| Feature | Current | Target |
|---------|---------|--------|
| Session Model | Single session per user | Multi-account browser sessions |
| SSO | None | Full cross-app SSO with prompt handling |
| Token Architecture | Basic JWT | Audience-specific, session-bound tokens |
| Multi-Tenant | Single tenant | Full tenant isolation with white-label |
| Admin Controls | Basic user CRUD | Complete session management |
| OIDC Compliance | Partial | Full prompt, login_hint, max_age support |

---

## Implementation Lanes

### Lane Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          IMPLEMENTATION TIMELINE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  PHASE 1 (Foundation)                                                        │
│  ═══════════════════                                                         │
│                                                                              │
│  ┌──────────────────┐                                                        │
│  │ LANE 1           │ ◄─── START HERE (No Dependencies)                      │
│  │ Multi-Account    │                                                        │
│  │ Sessions         │                                                        │
│  │ [15-22 hours]    │                                                        │
│  └────────┬─────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐                               │
│  │ LANE 2           │    │ LANE 4           │ ◄─── Can start after Lane 1   │
│  │ SSO & OIDC       │    │ Token            │      (parallel execution)     │
│  │ Parameters       │    │ Architecture     │                               │
│  │ [21-30 hours]    │    │ [21-30 hours]    │                               │
│  └────────┬─────────┘    └──────────────────┘                               │
│           │                                                                  │
│           ▼                                                                  │
│  PHASE 2 (APIs & UI)                                                         │
│  ═══════════════════                                                         │
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐       │
│  │ LANE 3           │    │ LANE 6           │    │ LANE 7           │       │
│  │ Session Mgmt     │    │ Admin Session    │    │ Admin & Profile  │       │
│  │ APIs             │    │ Controls         │    │ UI               │       │
│  │ [18-25 hours]    │    │ [25-34 hours]    │    │ [28-40 hours]    │       │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘       │
│                                                                              │
│  PHASE 3 (Enterprise - Optional)                                             │
│  ═══════════════════════════════                                             │
│                                                                              │
│  ┌──────────────────┐                                                        │
│  │ LANE 5           │ ◄─── Can start after Lane 1 (independent feature)     │
│  │ Multi-Tenant     │                                                        │
│  │ Infrastructure   │                                                        │
│  │ [43-57 hours]    │                                                        │
│  └──────────────────┘                                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Lane Details

### Lane 1: Multi-Account Sessions & Browser Sessions
**File**: `LANE-1-MULTI-ACCOUNT-SESSIONS.md`
**Priority**: P0 (Critical Foundation)
**Effort**: 15-22 hours
**Dependencies**: None

**Key Deliverables**:
- Database schema for browser_sessions and account_sessions tables
- BrowserSessionService and AccountSessionService
- Session cookie management
- User-agent parsing utility
- Support for up to 3 accounts per browser

**Database Migrations**:
- `0023_browser_sessions.sql`
- `0024_account_sessions_trigger.sql`

---

### Lane 2: SSO & OIDC Parameter Handling
**File**: `LANE-2-SSO-OIDC-PARAMETERS.md`
**Priority**: P0 (Critical)
**Effort**: 21-30 hours
**Dependencies**: Lane 1

**Key Deliverables**:
- `prompt` parameter handling (none, login, select_account, consent)
- `login_hint` parameter for email pre-fill
- `account_hint` parameter for account selection
- `max_age` parameter for re-auth enforcement
- Silent authentication flow
- Account selector UI
- Cross-app SSO without re-login

**Integration Points**:
- OpenAuth authorize endpoint modifications
- Custom authorize route handler

---

### Lane 3: Session Management APIs
**File**: `LANE-3-SESSION-MANAGEMENT-APIS.md`
**Priority**: P1 (High)
**Effort**: 18-25 hours
**Dependencies**: Lane 1, Lane 2

**Key Deliverables**:
- `/session/accounts` - List logged-in accounts
- `/session/switch` - Switch active account
- `/session/accounts/:userId` - Sign out one account
- `/session/all` - Sign out all accounts
- `/session/check` - Silent session check
- `/session/devices` - List all user sessions
- `/session/devices/:sessionId` - Remote logout
- Client SDK (SessionManager)
- AccountSwitcher UI component

---

### Lane 4: Token Architecture Enhancement
**File**: `LANE-4-TOKEN-ARCHITECTURE.md`
**Priority**: P1 (High)
**Effort**: 21-30 hours
**Dependencies**: Lane 1

**Key Deliverables**:
- Audience-specific tokens (different token per app)
- Token exchange endpoint (RFC 8693)
- Enhanced token introspection
- App-specific permissions in tokens
- Session-bound tokens
- Client permission management

**Database Migrations**:
- `0025_app_tokens.sql`
- `0026_oauth_clients_audience.sql`

---

### Lane 5: Multi-Tenant Infrastructure
**File**: `LANE-5-MULTI-TENANT.md`
**Priority**: P2 (Medium - Future Phase)
**Effort**: 43-57 hours
**Dependencies**: Lane 1 (for tenant_id field)

**Key Deliverables**:
- Tenant data model and CRUD
- Tenant isolation in all queries
- Custom domain routing
- White-label branding
- Tenant-specific OAuth clients
- Tenant-specific roles
- Tenant admin delegation
- Tenant management admin UI

**Database Migrations**:
- `0027_tenants.sql`
- `0028_tenant_columns.sql`
- `0029_tenant_admins.sql`

---

### Lane 6: Admin Session Controls & UI
**File**: `LANE-6-ADMIN-SESSION-CONTROLS.md`
**Priority**: P1 (High)
**Effort**: 25-34 hours
**Dependencies**: Lane 1, Lane 3

**Key Deliverables**:
- Admin API for viewing user sessions
- Force logout single user
- Force logout all sessions
- Terminate specific session
- Session monitoring dashboard
- Suspicious activity detection
- Session statistics

---

### Lane 7: Admin & Profile UI Implementation
**File**: `LANE-7-UI-IMPLEMENTATION.md`
**Priority**: P1 (High)
**Effort**: 28-40 hours
**Dependencies**: Lane 1, Lane 3

**Key Deliverables**:

**Admin Dashboard**:
- Sessions dashboard with stats and suspicious activity alerts
- User sessions management page
- OAuth client permissions management
- Navigation updates

**Profile Application**:
- Account switcher component (multi-account support)
- Sessions management page (view/revoke devices)
- Device card component
- Security settings

---

## Parallel Execution Strategy

### Maximum Parallelism (3 Agents)

```
Agent A                    Agent B                    Agent C
────────                   ────────                   ────────
Week 1-2:                  Week 1-2:                  Week 1-2:
  Lane 1 (Foundation)        [Waiting for Lane 1]       [Waiting for Lane 1]

Week 2-3:                  Week 2-3:                  Week 2-3:
  Lane 2 (SSO/OIDC)          Lane 4 (Tokens)            Lane 5 (Multi-Tenant)

Week 3-4:                  Week 3-4:                  Week 3-4:
  Lane 3 (Session APIs)      [Assist Lane 3/6]          [Continue Lane 5]

Week 4-5:                  Week 4-5:                  Week 4-5:
  Lane 6 (Admin UI)          [Assist Lane 6]            [Continue Lane 5]
```

### Minimum Parallelism (2 Agents)

```
Agent A                    Agent B
────────                   ────────
Week 1-2:                  Week 1-2:
  Lane 1 (Foundation)        [Waiting for Lane 1]

Week 2-3:                  Week 2-3:
  Lane 2 (SSO/OIDC)          Lane 4 (Tokens)

Week 3-4:                  Week 3-4:
  Lane 3 (Session APIs)      Lane 5 (Multi-Tenant Start)

Week 4-5:                  Week 4-5:
  Lane 6 (Admin UI)          Lane 5 (Multi-Tenant Cont.)
```

### Sequential Execution (1 Agent)

```
Week 1-2:   Lane 1 (Foundation)
Week 2-4:   Lane 2 (SSO/OIDC)
Week 4-5:   Lane 3 (Session APIs)
Week 5-7:   Lane 4 (Tokens)
Week 7-9:   Lane 6 (Admin UI)
Week 9-13:  Lane 5 (Multi-Tenant) [Optional]
```

---

## Total Effort Estimates

| Lane | Min Hours | Max Hours |
|------|-----------|-----------|
| Lane 1 | 15 | 22 |
| Lane 2 | 21 | 30 |
| Lane 3 | 18 | 25 |
| Lane 4 | 21 | 30 |
| Lane 5 | 43 | 57 |
| Lane 6 | 25 | 34 |
| Lane 7 | 28 | 40 |
| **Total** | **171** | **238** |

**Without Multi-Tenant (Lane 5)**: 128-181 hours

---

## Database Migration Order

```sql
-- Phase 1: Foundation
0023_browser_sessions.sql        -- Lane 1
0024_account_sessions_trigger.sql -- Lane 1

-- Phase 2: Tokens (can be parallel with 0023-0024)
0025_app_tokens.sql              -- Lane 4
0026_oauth_clients_audience.sql  -- Lane 4

-- Phase 3: Multi-Tenant (if implementing)
0027_tenants.sql                 -- Lane 5
0028_tenant_columns.sql          -- Lane 5
0029_tenant_admins.sql           -- Lane 5
```

---

## Integration Points

### OpenAuth 1.0.1 Integration

Each lane requires integration with OpenAuth at these points:

| Lane | Integration Point |
|------|-------------------|
| Lane 1 | Subject callback, session storage |
| Lane 2 | Authorize endpoint, beforeUI/afterAuth hooks |
| Lane 3 | Token generation, session binding |
| Lane 4 | Token claims, audience handling |
| Lane 5 | Tenant context in all operations |
| Lane 6 | Admin API authorization |

### Shared Services

Services that multiple lanes depend on:

- `BrowserSessionService` - Lanes 1, 2, 3, 6
- `AccountSessionService` - Lanes 1, 2, 3, 6
- `TokenService` - Lanes 4, 3, 6
- `TenantService` - Lane 5 (isolated)
- `AuditService` - All lanes (existing)

---

## Testing Strategy

### Unit Tests Per Lane

| Lane | Test Files | Coverage Target |
|------|------------|-----------------|
| Lane 1 | browser-session.service.test.ts, account-session.service.test.ts | >80% |
| Lane 2 | oidc-authorize.service.test.ts | >80% |
| Lane 3 | session-routes.test.ts | >80% |
| Lane 4 | token.service.test.ts | >80% |
| Lane 5 | tenant.service.test.ts | >80% |
| Lane 6 | admin-sessions.test.ts | >80% |

### E2E Tests

| Flow | Lanes Required |
|------|----------------|
| SSO Cross-App | 1, 2 |
| Multi-Account Switch | 1, 2, 3 |
| Remote Logout | 1, 3, 6 |
| Token Exchange | 1, 4 |
| Multi-Tenant SSO | 1, 2, 5 |

---

## Risk Mitigation

### Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| OpenAuth 1.0.1 breaking changes | High | Review changelog, test integration early |
| Migration data loss | Critical | Backup before migrations, test locally first |
| Session cookie conflicts | Medium | Careful domain configuration |
| Token backward compatibility | Medium | Gradual rollout with feature flags |

### Dependency Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Lane 1 delay | Critical | Prioritize, add resources if needed |
| Multi-tenant scope creep | Medium | Defer to Phase 3, clear scope |
| Integration complexity | Medium | Early integration testing |

---

## Success Criteria

### Phase 1 Complete (Lanes 1, 2)
- [ ] Users can have multiple accounts logged in
- [ ] Silent authentication works (prompt=none)
- [ ] Account selector shows on prompt=select_account
- [ ] Cross-app SSO works without re-login

### Phase 2 Complete (Lanes 3, 4, 6)
- [ ] Users can switch between accounts
- [ ] Users can see all their sessions
- [ ] Users can remote logout sessions
- [ ] Admins can force logout users
- [ ] Tokens have audience-specific claims
- [ ] Token exchange works between apps

### Phase 3 Complete (Lane 5)
- [ ] Multiple tenants can be created
- [ ] Users are isolated by tenant
- [ ] Custom domains route correctly
- [ ] Branding applies per tenant
- [ ] Tenant admins can manage their tenant

---

## Getting Started

### For a Single Developer

1. Start with Lane 1 (foundation)
2. After Lane 1, work on Lane 2 (SSO is critical)
3. Then Lane 3 (user-facing APIs)
4. Then Lane 4 (token improvements)
5. Then Lane 6 (admin controls)
6. Lane 5 (multi-tenant) can be deferred or done last

### For Multiple Developers

1. **Developer A**: Lane 1 → Lane 2 → Lane 3
2. **Developer B**: Wait for Lane 1 → Lane 4 → Lane 6
3. **Developer C** (optional): Wait for Lane 1 → Lane 5

### Prerequisites

Before starting any lane:
1. Ensure OpenAuth 1.0.1 is properly installed
2. Run existing tests to ensure baseline works
3. Review the IDENTITY_PLATFORM_SPEC.md
4. Set up local development environment

---

## Files Reference

```
docs/plans/
├── MASTER-IMPLEMENTATION-OVERVIEW.md  (this file)
├── LANE-1-MULTI-ACCOUNT-SESSIONS.md
├── LANE-2-SSO-OIDC-PARAMETERS.md
├── LANE-3-SESSION-MANAGEMENT-APIS.md
├── LANE-4-TOKEN-ARCHITECTURE.md
├── LANE-5-MULTI-TENANT.md
├── LANE-6-ADMIN-SESSION-CONTROLS.md
├── LANE-7-UI-IMPLEMENTATION.md        (Admin & Profile UI)
└── CLIENT-INTEGRATION-GUIDE.md        (for app developers)
```

Each lane document contains:
- Current state analysis
- Database schema changes
- Type definitions
- Service implementations
- Route implementations
- UI components (where applicable)
- Testing requirements
- Rollout checklist
- Estimated effort
- Security considerations
