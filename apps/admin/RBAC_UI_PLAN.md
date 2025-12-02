# RBAC UI Implementation Plan for Admin App

## Executive Summary

This plan outlines the migration of the admin app from legacy roles (`user`/`admin`) to the full RBAC system. The auth service already has complete RBAC APIs, and the admin app needs UI updates to leverage these capabilities.

## Current State Analysis

### Existing RBAC APIs in Auth Service

**Admin RBAC Routes (`/admin/roles/*`):**
- `GET /admin/roles` - List all roles
- `POST /admin/roles` - Create a new role
- `GET /admin/roles/:id` - Get role details with permissions
- `PUT /admin/roles/:id` - Update a role
- `DELETE /admin/roles/:id` - Delete a role
- `POST /admin/roles/:id/permissions` - Grant permission to role
- `DELETE /admin/roles/:id/permissions/:permissionId` - Revoke permission from role

**User RBAC Routes (`/api/users/*/roles`):**
- `GET /api/users/:id/roles` - Get user's assigned roles
- `POST /api/users/:id/roles` - Assign role to user
- `DELETE /api/users/:id/roles/:roleId` - Remove role from user
- `GET /api/users/:id/permissions` - Get user's effective permissions
- `GET /api/permissions` - List all permissions

### Current Admin App State
- Uses direct D1 database queries for users
- Displays legacy `role` column (user/admin)
- Create user dialog uses legacy role select
- No RBAC management UI exists

### Key Types (from `apps/auth/src/rbac-types.ts`)
- System roles: `super_admin`, `admin`, `moderator`, `user`
- Permission format: `resource:action:scope` (e.g., `users:read:all`)
- Role hierarchy support via `parent_role_id`

---

## Implementation Plan

### Phase 1: API Client Layer

**File: `apps/admin/app/lib/rbac-api.server.ts`** (NEW)

Create a server-side API client to communicate with the auth service RBAC endpoints:

```typescript
// API Client for RBAC endpoints
// Uses fetch to call auth service APIs with session cookie forwarding

interface Role {
  id: string;
  name: string;
  description?: string;
  is_system: boolean;
  parent_role_id?: string;
}

interface Permission {
  id: string;
  name: string;
  resource: string;
  action: string;
  scope: string;
  description?: string;
}

interface UserRole {
  id: string;
  roleId: string;
  userId: string;
  grantedBy: string;
  grantedAt: Date;
  expiresAt?: Date;
  role: Role;
}

// Functions:
// - getAllRoles(request, env)
// - getRoleById(id, request, env)
// - createRole(data, request, env)
// - updateRole(id, data, request, env)
// - deleteRole(id, request, env)
// - getUserRoles(userId, request, env)
// - assignRoleToUser(userId, roleId, request, env)
// - removeRoleFromUser(userId, roleId, request, env)
// - getAllPermissions(request, env)
// - grantPermissionToRole(roleId, permissionId, request, env)
// - revokePermissionFromRole(roleId, permissionId, request, env)
```

**Key Implementation Details:**
- Forward session cookies for authentication
- Use `getAuthServerUrl()` from config.ts
- Handle error responses appropriately
- Return typed responses

---

### Phase 2: Update User List Page

**File: `apps/admin/app/routes/users._index.tsx`** (MODIFY)

**Changes:**
1. Update loader to fetch user roles via RBAC API
2. Display multiple roles as badges instead of single role
3. Add role management per user (assign/remove roles)
4. Implement user creation with RBAC role selection
5. Implement user deletion

**Loader Changes:**
```typescript
// In loader:
// 1. Get all users from D1 (existing)
// 2. For each user, fetch their RBAC roles via API
// 3. Fetch all available roles for the role assignment dropdown
```

**UI Changes:**
- Replace single role display with multi-role badges
- Add "Manage Roles" button per user row
- Update create user dialog with multi-select role picker
- Add confirmation dialogs for destructive actions

**New Components Needed:**
- Role badge component (with color coding)
- Multi-select role picker
- User role management dialog

---

### Phase 3: New UI Components

**File: `apps/admin/app/components/ui/badge.tsx`** (NEW)
Standard shadcn badge component for displaying roles.

**File: `apps/admin/app/components/ui/select.tsx`** (NEW)
Standard shadcn select component for role selection.

**File: `apps/admin/app/components/ui/checkbox.tsx`** (NEW)
For multi-select role picker.

**File: `apps/admin/app/components/ui/alert-dialog.tsx`** (NEW)
For confirmation dialogs.

**File: `apps/admin/app/components/user-role-badge.tsx`** (NEW)
```typescript
// Displays a role badge with appropriate styling
// System roles get special colors (super_admin = red, admin = blue, etc.)
```

**File: `apps/admin/app/components/user-role-manager.tsx`** (NEW)
```typescript
// Dialog component for managing a user's roles
// - Lists current roles with remove buttons
// - Dropdown to add new roles
// - Handles loading/error states
```

---

### Phase 4: Roles Management Page

**File: `apps/admin/app/routes/roles._index.tsx`** (NEW)

A dedicated page for managing roles:

**Features:**
- List all roles (system and custom)
- Create new custom roles
- Edit custom roles (name, description, parent role)
- Delete custom roles (with usage check)
- View/manage role permissions

**Loader:**
- Fetch all roles
- Fetch all permissions (for assignment UI)

**UI Components:**
- Roles table with actions
- Create role dialog
- Edit role dialog
- Permissions management section per role

**File: `apps/admin/app/routes/roles.$id.tsx`** (NEW)

Detailed role view/edit page:
- Role metadata editing
- Permissions list with add/remove
- Users with this role list
- Hierarchy visualization (parent/child roles)

---

### Phase 5: Route Configuration Updates

**File: `apps/admin/app/routes.ts`** (MODIFY)

Add new routes:
```typescript
export default [
  index("routes/_index.tsx"),
  route("users", "routes/users._index.tsx"),
  route("roles", "routes/roles._index.tsx"),           // NEW
  route("roles/:id", "routes/roles.$id.tsx"),          // NEW
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),
] satisfies RouteConfig;
```

---

### Phase 6: Dashboard Updates

**File: `apps/admin/app/routes/_index.tsx`** (MODIFY)

**Changes:**
1. Update stats to show role breakdown instead of just admin count
2. Add quick action card for "Role Management"
3. Add roles count stat card

**New Stats:**
- Total Roles
- Custom Roles
- Users by Role (breakdown)

---

### Phase 7: Database Query Updates

**File: `apps/admin/app/lib/db.server.ts`** (MODIFY)

**Changes:**
1. Add function to get users with their RBAC roles (single query with JOIN)
2. Update `getUserStats` to include role breakdown
3. Add pagination support for users list

**New Functions:**
```typescript
// Get users with their RBAC roles
export async function getAllUsersWithRoles(db: D1Database): Promise<UserWithRoles[]>

// Get role statistics
export async function getRoleStats(db: D1Database): Promise<RoleStats>

// Get users by role
export async function getUsersByRole(db: D1Database, roleId: string): Promise<User[]>
```

---

## Data Flow Diagrams

### User Roles Display Flow
```
1. Loader calls getAllUsersWithRoles(db)
2. For each user, JOIN with user_roles and roles tables
3. Return users with roles array
4. Component renders user rows with role badges
```

### Role Assignment Flow
```
1. User clicks "Manage Roles" on user row
2. Open UserRoleManager dialog
3. Fetch current user roles + all available roles
4. User selects role to add or remove
5. Call RBAC API (POST/DELETE /api/users/:id/roles/:roleId)
6. Refresh user data via loader revalidation
```

### Role Management Flow
```
1. Navigate to /roles
2. Loader fetches all roles + permissions
3. Display roles table with actions
4. Create/Edit/Delete via dialogs
5. Call admin RBAC APIs
6. Refresh via loader revalidation
```

---

## Potential Issues and Considerations

### 1. API Authentication
The admin app needs to forward session cookies to the auth service. The auth service validates admin access before allowing RBAC operations.

### 2. System Role Protection
System roles (`super_admin`, `admin`, `moderator`, `user`) cannot be modified or deleted. UI should disable edit/delete buttons for system roles.

### 3. Privilege Escalation Prevention
The auth service already prevents privilege escalation (users can only grant permissions they have). UI should handle 403 errors gracefully.

### 4. Rate Limiting
RBAC APIs have rate limits (10-20 operations per hour). UI should show appropriate error messages when rate limited.

### 5. Cache Invalidation
Role/permission changes trigger cache invalidation in the auth service. Sessions may need refresh after major changes.

### 6. Loading States
All API calls should show loading indicators. Consider skeleton loaders for initial page loads.

### 7. Error Handling
- 401: Redirect to login
- 403: Show permission denied message
- 404: Show not found message
- 429: Show rate limit message with retry-after
- 500: Show generic error with retry option

---

## Files Summary

### New Files
| File Path | Purpose |
|-----------|---------|
| `apps/admin/app/lib/rbac-api.server.ts` | API client for RBAC endpoints |
| `apps/admin/app/components/ui/badge.tsx` | Badge component |
| `apps/admin/app/components/ui/select.tsx` | Select component |
| `apps/admin/app/components/ui/checkbox.tsx` | Checkbox for multi-select |
| `apps/admin/app/components/ui/alert-dialog.tsx` | Confirmation dialogs |
| `apps/admin/app/components/user-role-badge.tsx` | Role badge with styling |
| `apps/admin/app/components/user-role-manager.tsx` | User role management dialog |
| `apps/admin/app/routes/roles._index.tsx` | Roles list page |
| `apps/admin/app/routes/roles.$id.tsx` | Role detail/edit page |

### Modified Files
| File Path | Changes |
|-----------|---------|
| `apps/admin/app/routes/users._index.tsx` | RBAC roles display, role management |
| `apps/admin/app/routes/_index.tsx` | Dashboard stats, roles quick action |
| `apps/admin/app/routes.ts` | New route definitions |
| `apps/admin/app/lib/db.server.ts` | Users with roles query, role stats |

---

## Implementation Sequence

### Phase 1: Foundation
- Create `rbac-api.server.ts` API client
- Add new UI components (badge, select, alert-dialog)
- Update routes.ts

### Phase 2: User Roles
- Update users._index.tsx to show RBAC roles
- Create user role manager component
- Implement role assignment/removal

### Phase 3: Roles Page
- Create roles._index.tsx
- Implement role CRUD operations
- Add permission management

### Phase 4: Polish
- Update dashboard with role stats
- Add loading states and error handling
- Test privilege escalation prevention
- Documentation and cleanup
