# ADR-003: Role-Based Access Control (RBAC) System

## Status
Accepted

## Context
The Al Ummah Now platform currently has a simple binary role system (`admin` vs `user`) stored in the users table. As the platform grows, we need a more sophisticated permission system that can:

1. Support fine-grained permissions for different features
2. Allow flexible role definitions beyond just admin/user
3. Enable resource-based permissions (e.g., own content vs all content)
4. Scale to support multi-tenancy in the future
5. Provide efficient permission checking at the edge
6. Integrate with our audit logging system
7. Maintain backward compatibility with existing role field

### Current Limitations
- Binary role system (admin/user only)
- Permissions hardcoded in application logic
- No support for custom roles
- No granular permission control
- No permission inheritance or hierarchy
- No resource-based permissions

### Requirements
- **Performance**: Sub-millisecond permission checks at the edge
- **Flexibility**: Support custom roles and permissions
- **Scalability**: Handle thousands of permissions and roles
- **Security**: Audit all permission changes
- **Compatibility**: Work with existing role field
- **Simplicity**: Easy to understand and maintain

## Decision
We will implement a comprehensive RBAC system with the following architecture:

### 1. **Hierarchical Permission Model**
Permissions follow a `resource:action:scope` format:
- **Resource**: The entity being accessed (users, content, settings)
- **Action**: The operation (read, write, delete, manage)
- **Scope**: The boundary (own, team, all)

Examples:
- `users:read:all` - Can read all users
- `content:write:own` - Can write own content
- `settings:manage:*` - Can manage all settings

### 2. **Role Hierarchy with Inheritance**
Roles can inherit from parent roles:
```
super_admin
  ├── admin
  │   ├── content_admin
  │   └── user_admin
  └── moderator
      └── user (base role)
```

### 3. **Database Schema Design**
Four main tables with junction tables for relationships:

```sql
-- Core RBAC tables
roles                  -- Role definitions
permissions            -- Permission definitions
role_permissions       -- Role → Permission mapping
user_roles            -- User → Role mapping (multiple roles per user)

-- Resource permissions (future)
resource_permissions   -- Resource-specific permissions
permission_policies   -- Complex permission rules (JSON)
```

### 4. **Permission Checking Strategy**

#### Cache-First Approach
1. **Edge Cache**: User permissions cached in KV (5-minute TTL)
2. **Request Context**: Permissions loaded once per request
3. **Database Fallback**: Fresh load if cache miss

#### Checking Algorithm
```typescript
// Efficient permission check
async function hasPermission(
  userId: string,
  permission: string,
  resource?: { type: string; id: string; ownerId?: string }
): Promise<boolean> {
  // 1. Get user's effective permissions (cached)
  // 2. Check for exact match
  // 3. Check for wildcard match
  // 4. Check resource-specific rules
  // 5. Apply scope rules (own/team/all)
}
```

### 5. **Migration Strategy**
To maintain backward compatibility:

1. **Phase 1**: Deploy RBAC tables and APIs
   - Existing `user.role` field remains primary
   - RBAC runs in shadow mode (logging only)

2. **Phase 2**: Dual-write mode
   - Write to both old role field and new RBAC tables
   - Read from RBAC with fallback to role field

3. **Phase 3**: Full migration
   - RBAC becomes primary
   - Role field deprecated but maintained for compatibility

### 6. **Permission Assignment Flow**
```
User → User_Roles → Roles → Role_Permissions → Permissions
         ↓                        ↓
    Direct Grants          Permission Policies
         ↓                        ↓
    (Override)              (Complex Rules)
```

### 7. **Standard Permission Sets**

#### Core Permissions
- `auth:*` - Authentication management
- `users:*` - User management
- `content:*` - Content management
- `settings:*` - System settings
- `audit:*` - Audit log access
- `analytics:*` - Analytics access

#### Default Roles
1. **super_admin**: All permissions (`*:*:*`)
2. **admin**: All except system-critical operations
3. **moderator**: Content and user moderation
4. **content_creator**: Create and manage own content
5. **user**: Basic read permissions

### 8. **API Design**

#### Role Management
```typescript
POST   /api/roles                 // Create role
GET    /api/roles                 // List roles
GET    /api/roles/:id             // Get role details
PUT    /api/roles/:id             // Update role
DELETE /api/roles/:id             // Delete role
POST   /api/roles/:id/permissions // Assign permissions
DELETE /api/roles/:id/permissions // Revoke permissions
```

#### User Role Assignment
```typescript
GET    /api/users/:id/roles       // Get user's roles
POST   /api/users/:id/roles       // Assign role to user
DELETE /api/users/:id/roles/:roleId // Remove role from user
GET    /api/users/:id/permissions // Get effective permissions
```

#### Permission Checking
```typescript
POST   /api/permissions/check     // Check permission
GET    /api/permissions           // List all permissions
POST   /api/permissions/bulk-check // Check multiple permissions
```

### 9. **Security Considerations**

#### Permission Escalation Prevention
- Users cannot grant permissions they don't have
- Role changes require higher privilege than the role being granted
- Super admin actions require additional authentication

#### Audit Integration
All RBAC operations are logged:
- Role creation/modification/deletion
- Permission assignments
- User role changes
- Permission check failures for sensitive resources

#### Session Invalidation
When permissions change:
1. Invalidate user's cached permissions in KV
2. Invalidate active sessions (force re-auth)
3. Log security event

### 10. **Performance Optimizations**

#### Caching Strategy
```typescript
// Permission cache key structure
`perms:${userId}` → {
  roles: string[],
  permissions: string[],
  expiresAt: timestamp,
  version: number
}
```

#### Bulk Loading
- Load all user permissions in single query
- Denormalized permission view for fast reads
- Materialized permission sets for common roles

#### Edge Optimization
- Minimal permission set in JWT claims
- Full permissions loaded from KV at edge
- Lazy loading for resource-specific checks

## Consequences

### Positive
- **Flexibility**: Support any permission model
- **Scalability**: Handles complex permission requirements
- **Performance**: Edge-optimized with caching
- **Security**: Fine-grained access control
- **Auditability**: Complete permission audit trail
- **Extensibility**: Ready for multi-tenancy
- **Maintainability**: Clear separation of concerns

### Negative
- **Complexity**: More complex than current system
  - *Mitigation*: Provide helper functions and clear documentation
- **Migration Risk**: Potential for permission issues during migration
  - *Mitigation*: Phased migration with fallback
- **Cache Invalidation**: Complex cache management
  - *Mitigation*: Conservative TTLs and versioning
- **Storage Overhead**: Additional database tables
  - *Mitigation*: Efficient schema design with indexes

## Alternatives Considered

### 1. **Attribute-Based Access Control (ABAC)**
- More flexible but too complex for current needs
- Would require expression evaluation at runtime
- Rejected due to complexity and performance concerns

### 2. **Simple Role Expansion**
- Just add more roles to existing system
- No permission granularity
- Rejected as not scalable enough

### 3. **OAuth Scopes Only**
- Use OAuth2 scopes as permissions
- Limited to token-based auth
- Rejected as too restrictive

### 4. **Policy-Based (Casbin/OPA style)**
- External policy engine
- Would work but adds operational complexity
- Rejected for initial implementation (can add later)

## Implementation Notes

### Database Indexes
Critical indexes for performance:
```sql
-- Composite indexes for permission lookups
CREATE INDEX idx_user_roles_lookup ON user_roles(user_id, role_id);
CREATE INDEX idx_role_permissions_lookup ON role_permissions(role_id, permission_id);
CREATE INDEX idx_permissions_resource ON permissions(resource, action);
```

### Permission Naming Convention
```
<resource>:<action>:<scope>

Resources: users, content, settings, audit, analytics, system
Actions: create, read, update, delete, list, manage, execute
Scopes: own, team, org, all, * (wildcard)
```

### Wildcard Support
- `users:*:all` - All user operations
- `*:read:own` - Read own resources of any type
- `*:*:*` - Super admin (all permissions)

### Error Handling
- Permission denied returns 403 Forbidden
- Missing permissions return empty/filtered results
- Invalid permission format returns 400 Bad Request

### Testing Strategy
1. Unit tests for permission matching logic
2. Integration tests for role inheritance
3. End-to-end tests for permission flows
4. Performance tests for permission checks
5. Migration tests with production data copy

### Monitoring
- Track permission check latency (P50, P95, P99)
- Monitor cache hit rates
- Alert on permission escalation attempts
- Dashboard for role/permission distribution

### Rollback Plan
1. Feature flag to disable RBAC checks
2. Fallback to original role field
3. Cache clear mechanism
4. Database migration rollback scripts

## Migration Timeline
- **Week 1-2**: Database schema and core models
- **Week 3-4**: APIs and permission checking logic
- **Week 5-6**: Admin UI for role management
- **Week 7-8**: Migration tooling and testing
- **Week 9-10**: Staged rollout with monitoring
- **Week 11-12**: Full deployment and cleanup

## Future Enhancements
1. **Resource-based permissions**: Permissions tied to specific resources
2. **Delegation**: Temporary permission delegation
3. **Approval workflows**: Multi-step permission grants
4. **Time-based permissions**: Temporary elevated access
5. **Multi-tenancy**: Organization-scoped roles
6. **Policy engine**: Complex permission rules
7. **Permission templates**: Reusable permission sets
8. **Audit analytics**: Permission usage insights

## References
- [NIST RBAC Model](https://csrc.nist.gov/projects/role-based-access-control)
- [OAuth 2.0 Scopes](https://www.rfc-editor.org/rfc/rfc6749#section-3.3)
- [Zanzibar: Google's Global Authorization System](https://research.google/pubs/pub48190/)
- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)