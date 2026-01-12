/**
 * Debug endpoint to test M2M authentication flow
 * GET /debug/m2m - Tests the M2M token request and /admin/roles API call
 *
 * This endpoint is for debugging only and should be disabled in production.
 */

import type { LoaderFunctionArgs } from "react-router";
import { listRoles, type Role } from "../lib/admin-api.server";

interface DebugResponse {
  success: boolean;
  config: {
    authServerUrl: string | undefined;
    adminClientId: string | undefined;
    hasClientSecret: boolean;
  };
  m2mTest?: {
    rolesCount: number;
    roles?: Role[];
    error?: string;
  };
  error?: string;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env as {
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };

  const response: DebugResponse = {
    success: false,
    config: {
      authServerUrl: env.AUTH_SERVER_URL,
      adminClientId: env.ADMIN_CLIENT_ID,
      hasClientSecret: !!env.ADMIN_CLIENT_SECRET,
    },
  };

  // Check if all required config is present
  if (!env.AUTH_SERVER_URL || !env.ADMIN_CLIENT_ID || !env.ADMIN_CLIENT_SECRET) {
    response.error = 'Missing M2M configuration';
    return Response.json(response, { status: 500 });
  }

  try {
    // Use the seeded system admin user for the API call
    // This user is created by seed-openauth-roles.sql with Super Admin role
    const actingUser = {
      id: 'system_admin_user',
      email: 'system-admin@internal.local',
      roles: ['Super Admin'],
    };

    // Call listRoles to test the full M2M flow
    const rolesResult = await listRoles(env, actingUser, request);

    if ('error' in rolesResult) {
      response.m2mTest = {
        rolesCount: 0,
        error: rolesResult.error,
      };
      response.error = `M2M request failed: ${rolesResult.error}`;
      return Response.json(response, { status: 500 });
    }

    response.success = true;
    response.m2mTest = {
      rolesCount: rolesResult.length,
      roles: rolesResult,
    };

    return Response.json(response);
  } catch (error) {
    response.error = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(response, { status: 500 });
  }
}

// No default export - this is a resource route that returns JSON only
