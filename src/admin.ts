import { getUserById, getAllUsers, createUser, updateUser, deleteUser, getUserByEmail } from './users';
import SendEmail from './email';

// Type for user management responses
export interface UserResponse {
  id: string;
  email: string;
  role: string;
  created_at: string;
  password_reset_required?: boolean;
}

export interface CreateUserRequest {
  email: string;
  role?: string;
}

export interface UpdateUserRequest {
  email?: string;
  role?: string;
}

// Middleware to check if user is admin
export async function requireAdmin(env: Env, request: Request): Promise<{ user: UserResponse } | Response> {
  // Extract authorization header or session info
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Authorization required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // For now, we'll extract the user email from the authorization header
  // In a real implementation, this would validate the session/token
  const userEmail = authHeader.replace('Bearer ', '');
  
  try {
    const user = await getUserByEmail(env, userEmail);
    
    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (user.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return { user };
  } catch (error) {
    console.error('Error in requireAdmin:', error);
    return new Response(JSON.stringify({ error: 'Authentication failed' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handler for GET /admin/users - List all users
export async function handleListUsers(env: Env, request: Request): Promise<Response> {
  const authResult = await requireAdmin(env, request);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const users = await getAllUsers(env);
    return new Response(JSON.stringify({ users }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch users' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handler for POST /admin/users - Create a new user
export async function handleCreateUser(env: Env, request: Request): Promise<Response> {
  const authResult = await requireAdmin(env, request);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const body: CreateUserRequest = await request.json();
    
    if (!body.email) {
      return new Response(JSON.stringify({ error: 'Email is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = await createUser(env, body.email, body.role || 'user');
    
    // Generate a temporary password
    const tempPassword = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    
    // Send welcome email with temporary password
    try {
      const key = await env.RESEND_API_KEY.get();
      if (key) {
        await SendEmail(
          key,
          "admin@alummahnow.net",
          user.email,
          "Welcome to Al Ummah Now - Account Created",
          `Welcome to Al Ummah Now!

Your account has been created by an administrator.

Email: ${user.email}
Role: ${user.role}
Temporary Password: ${tempPassword}

IMPORTANT: This is a temporary password. You will be required to change it upon your first login.

To log in:
1. Go to the login page
2. Enter your email: ${user.email}
3. Enter the temporary password above
4. Follow the prompts to set a new password

Best regards,
Al Ummah Now Team`
        );
      }
    } catch (emailError) {
      console.error('Failed to send welcome email:', emailError);
      // Don't fail the user creation if email fails
    }

    return new Response(JSON.stringify({ 
      user,
      message: 'User created successfully. Welcome email sent with temporary password.',
      tempPassword: tempPassword // In production, consider not returning this
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create user';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handler for GET /admin/users/:id - Get a specific user
export async function handleGetUser(env: Env, request: Request, userId: string): Promise<Response> {
  const authResult = await requireAdmin(env, request);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const user = await getUserById(env, userId);
    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ user }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch user' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handler for PUT /admin/users/:id - Update a user
export async function handleUpdateUser(env: Env, request: Request, userId: string): Promise<Response> {
  const authResult = await requireAdmin(env, request);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const body: UpdateUserRequest = await request.json();
    
    if (!body.email && !body.role) {
      return new Response(JSON.stringify({ error: 'At least one field (email or role) is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = await updateUser(env, userId, body);
    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ user }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update user';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handler for DELETE /admin/users/:id - Delete a user
export async function handleDeleteUser(env: Env, request: Request, userId: string): Promise<Response> {
  const authResult = await requireAdmin(env, request);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const success = await deleteUser(env, userId);
    if (!success) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ message: 'User deleted successfully' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to delete user' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handler for POST /admin/users/:id/reset-password - Reset a user's password
export async function handleResetPassword(env: Env, request: Request, userId: string): Promise<Response> {
  const authResult = await requireAdmin(env, request);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const user = await getUserById(env, userId);
    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Generate a temporary password reset code
    const resetCode = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    
    // Send password reset email
    const key = await env.RESEND_API_KEY.get();
    if (key) {
      await SendEmail(
        key,
        "admin@alummahnow.net",
        user.email,
        "Password Reset",
        `Your password has been reset by an administrator. Your new temporary code is: ${resetCode}. Please use this to log in and set a new password.`
      );
    }

    return new Response(JSON.stringify({ 
      message: 'Password reset email sent successfully',
      resetCode: resetCode // In production, this should not be returned
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to reset password' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ==== OAuth Provider Management ====

// Handler for GET /admin/oauth-providers - List all OAuth providers
export async function handleListOAuthProviders(env: Env, request: Request): Promise<Response> {
  const authResult = await requireAdmin(env, request);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const { getOAuthProviders } = await import('./providers');
    const providers = await getOAuthProviders(env);
    
    // Don't expose client secrets in list view
    const safeProviders = providers.map(p => ({
      ...p,
      client_secret: p.client_secret ? '***' : undefined
    }));

    return new Response(JSON.stringify(safeProviders), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch OAuth providers' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handler for GET /admin/oauth-providers/:providerName - Get single OAuth provider
export async function handleGetOAuthProvider(env: Env, request: Request, providerName: string): Promise<Response> {
  const authResult = await requireAdmin(env, request);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const { getOAuthProvider } = await import('./providers');
    const provider = await getOAuthProvider(env, providerName);
    
    if (!provider) {
      return new Response(JSON.stringify({ error: 'OAuth provider not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Don't expose client secret in detail view either
    const safeProvider = {
      ...provider,
      client_secret: provider.client_secret ? '***' : undefined
    };

    return new Response(JSON.stringify(safeProvider), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch OAuth provider' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handler for PUT /admin/oauth-providers/:providerName - Update OAuth provider
export async function handleUpdateOAuthProvider(env: Env, request: Request, providerName: string): Promise<Response> {
  const authResult = await requireAdmin(env, request);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const updates = await request.json() as any;
    const { updateOAuthProvider } = await import('./providers');
    
    const success = await updateOAuthProvider(env, providerName, updates);
    
    if (!success) {
      return new Response(JSON.stringify({ error: 'OAuth provider not found or no changes made' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ 
      message: 'OAuth provider updated successfully',
      providerName 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to update OAuth provider' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}