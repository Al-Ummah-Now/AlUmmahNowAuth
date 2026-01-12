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
    // Create a mock acting user for the API call
    const actingUser = {
      id: 'debug-user',
      email: 'debug@test.local',
      roles: ['admin'],
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

export default function DebugM2M() {
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold">M2M Debug Endpoint</h1>
      <p>This endpoint is for API debugging only. Use GET /debug/m2m</p>
    </div>
  );
}
