// Session management utilities for auth app

export interface SessionData {
  user: {
    id: string;
    email: string;
    roles: string[];
  };
  tokens: {
    access: string;
    refresh?: string;
  };
  expiresAt: string;
}

/**
 * Get session from cookie
 */
export function getSessionTokenFromCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = Object.fromEntries(
    cookieHeader.split("; ").map(c => {
      const [key, ...v] = c.split("=");
      return [key, v.join("=")];
    })
  );

  return cookies["auth_session"] || null;
}

/**
 * Get user session from KV storage
 */
export async function getUserSession(
  request: Request,
  storage: KVNamespace
): Promise<SessionData | null> {
  const sessionToken = getSessionTokenFromCookie(request);
  if (!sessionToken) return null;

  try {
    const sessionData = await storage.get(`session:${sessionToken}`);
    if (!sessionData) return null;

    // Parse session data with error handling
    let session: SessionData;
    try {
      session = JSON.parse(sessionData) as SessionData;
    } catch (parseError) {
      console.error("Failed to parse session data, deleting corrupted session:", parseError);
      await storage.delete(`session:${sessionToken}`);
      return null;
    }

    // Check if session is expired
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      await storage.delete(`session:${sessionToken}`);
      return null;
    }

    return session;
  } catch (error) {
    console.error("Error retrieving session:", error);
    return null;
  }
}

/**
 * Create a new session in KV storage
 */
export async function createSession(
  storage: KVNamespace,
  sessionData: SessionData
): Promise<string> {
  const sessionToken = crypto.randomUUID();

  await storage.put(
    `session:${sessionToken}`,
    JSON.stringify(sessionData),
    { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
  );

  return sessionToken;
}

/**
 * Delete session from KV storage
 */
export async function deleteSession(
  request: Request,
  storage: KVNamespace
): Promise<void> {
  const sessionToken = getSessionTokenFromCookie(request);
  if (!sessionToken) return;

  await storage.delete(`session:${sessionToken}`);
}

/**
 * Create a Set-Cookie header for the session
 */
export function createSessionCookie(sessionToken: string, isLocalhost: boolean = false): string {
  // Don't use Secure flag in local development (localhost uses HTTP)
  const secureFlag = isLocalhost ? "" : "Secure; ";
  return `auth_session=${sessionToken}; Path=/; HttpOnly; ${secureFlag}SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`;
}

/**
 * Create a Set-Cookie header to clear the session
 */
export function clearSessionCookie(isLocalhost: boolean = false): string {
  const secureFlag = isLocalhost ? "" : "Secure; ";
  return `auth_session=; Path=/; HttpOnly; ${secureFlag}SameSite=Strict; Max-Age=0`;
}
