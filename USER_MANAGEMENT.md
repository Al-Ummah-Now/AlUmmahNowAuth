# User Management Documentation

## Overview

The Al Ummah Now Auth system now includes comprehensive user management capabilities with role-based access control. Administrators can manage users through both a web interface and REST API endpoints.

## Features

- **Role-based access control**: Support for `user` and `admin` roles
- **User CRUD operations**: Create, read, update, and delete users
- **Password reset functionality**: Admins can reset user passwords
- **Web-based admin interface**: Easy-to-use HTML interface for user management
- **REST API**: Programmatic access to all user management functions

## Database Changes

The system includes a new migration (`0003_add_user_role.sql`) that:
- Adds a `role` column to the user table with default value `'user'`
- Creates an index for role-based queries
- Sets the first user as admin (if any users exist)

## Admin Interface

Access the admin interface at `/admin` on your deployed worker. The interface provides:

1. **Authentication Section**: Enter your admin email for authorization
2. **Create New User**: Add users with specified roles
3. **User Management Table**: View, edit, and delete existing users

### Admin Interface Features:
- List all users with their details
- Create new users with admin or user roles
- Toggle user roles between admin and user
- Reset user passwords (sends email notification)
- Delete users (with confirmation)

## API Endpoints

All admin endpoints require authentication via the `Authorization` header with format `Bearer {admin-email}`.

### Authentication

```
Authorization: Bearer admin@example.com
```

**Note**: In production, this should be replaced with proper JWT token validation or session management.

### Endpoints

#### List All Users
```
GET /admin/users
```
Returns array of all users with their details.

#### Create User
```
POST /admin/users
Content-Type: application/json

{
  "email": "user@example.com",
  "role": "user" // optional, defaults to "user"
}
```

#### Get Specific User
```
GET /admin/users/{user-id}
```

#### Update User
```
PUT /admin/users/{user-id}
Content-Type: application/json

{
  "email": "newemail@example.com", // optional
  "role": "admin" // optional
}
```

#### Delete User
```
DELETE /admin/users/{user-id}
```

#### Reset User Password
```
POST /admin/users/{user-id}/reset-password
```
Sends a password reset email to the user.

## Security Considerations

1. **Authentication**: The current implementation uses email-based authorization for simplicity. In production, implement proper JWT token validation.

2. **Authorization**: Only users with `admin` role can access admin endpoints.

3. **First User**: The migration automatically makes the first user an admin to bootstrap the system.

4. **Password Reset**: Generates temporary codes and sends them via email. Consider implementing more secure password reset flows in production.

## Usage Examples

### Setting up the first admin

1. Deploy the application with the new migration
2. Create your first user by logging in through the normal authentication flow
3. The first user will automatically be granted admin role
4. Access `/admin` to manage other users

### Managing users via API

```bash
# List users (replace with your admin email)
curl -H "Authorization: Bearer admin@example.com" \
     https://your-worker.workers.dev/admin/users

# Create a new admin user
curl -X POST \
     -H "Authorization: Bearer admin@example.com" \
     -H "Content-Type: application/json" \
     -d '{"email":"newadmin@example.com","role":"admin"}' \
     https://your-worker.workers.dev/admin/users

# Reset a user's password
curl -X POST \
     -H "Authorization: Bearer admin@example.com" \
     https://your-worker.workers.dev/admin/users/{user-id}/reset-password
```

## Integration Notes

- The user subject schema now includes the `role` field, so client applications can access user roles
- Existing authentication flows continue to work unchanged
- The migration preserves all existing users and data

## Related Documentation

- [Roadmap](./ROADMAP.md) - Strategic planning for user management features
- [Architecture](./ARCHITECTURE.md) - Technical architecture including user management
- [Authentication Flows](./AUTHENTICATION_FLOWS.md) - How authentication integrates with user management
- [CI/CD Documentation](./CICD.md) - Deployment processes for user management changes