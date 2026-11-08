/**
 * Debug endpoint to test M2M authentication flow
 * GET /debug/m2m - Tests the M2M token request and /admin/roles API call
 *
 * Unauthenticated, so it only answers on non-production hosts (QA E2E uses it
 * to prove the M2M secret works) and returns 404 everywhere else. It reports a
 * role count, never the roles themselves.
 */

import type { LoaderFunctionArgs } from "react-router";
import { listRoles } from "../lib/admin-api.server";

/** Hosts where this unauthenticated probe may answer. Production is never listed. */
export function isDebugHost(appUrl: string | undefined, requestUrl: string): boolean {
  let host: string;
  try {
    host = new URL(appUrl || requestUrl).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || /\.(qa|stage)\.alummahnow\.net$/.test(host);
}

interface DebugResponse {
  success: boolean;
  config: {
    authServerUrl: string | undefined;
    adminClientId: string | undefined;
    hasClientSecret: boolean;
  };
  m2mTest?: {
    rolesCount: number;
    error?: string;
  };
  error?: string;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env as {
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
    APP_URL?: string;
  };

  if (!isDebugHost(env.APP_URL, request.url)) {
    return new Response("Not Found", { status: 404 });
  }

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
    };

    return Response.json(response);
  } catch (error) {
    response.error = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(response, { status: 500 });
  }
}

// No default export - this is a resource route that returns JSON only
