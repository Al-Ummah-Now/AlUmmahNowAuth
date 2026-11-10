/**
 * Auth's theme admin API (/admin/themes on the auth server), called with the
 * admin app's M2M token on behalf of the signed-in Auth admin.
 */
import type { AuthThemeJson, StoredAsset } from '../../../../packages/ui/src/auth-theme/types.ts';
import type { Issue } from '../../../../packages/ui/src/theme-packages/validate.ts';
import { requireAuth } from './auth.server';
import { m2mFetch, type ActingUser } from './admin-api.server';

export type ThemeEnv = {
  AUTH_STORAGE: KVNamespace;
  AUTH_SERVER_URL?: string;
  ADMIN_CLIENT_ID?: string;
  ADMIN_CLIENT_SECRET?: string;
};

export interface ThemeSummary {
  id: string;
  name: { en: string; ar: string };
  kind: 'builtin' | 'custom';
  status: 'published' | 'draft' | 'changed';
  version: string | null;
  draftVersion: string | null;
  basedOn: string | null;
  isAuthDefault: boolean;
  clientIds: string[];
  updatedAt: number | null;
  updatedBy: string | null;
  publishedAt: number | null;
}

export interface ThemeList {
  themes: ThemeSummary[];
  authDefault: string;
  clientDefaults: Record<string, string>;
}

export interface ThemeDetail {
  summary: ThemeSummary;
  theme: AuthThemeJson;
  assets: Record<string, StoredAsset>;
  assetUrls: Record<string, string>;
}

export class ThemeApiError extends Error {
  constructor(public status: number, message: string, public details?: Issue[]) {
    super(message);
  }
}

/** The signed-in admin, as the acting user for M2M calls. */
export async function themeActor(request: Request, env: ThemeEnv): Promise<ActingUser> {
  const user = (await requireAuth(request, env, true)) as { id: string; email: string; roles?: string[] };
  return { id: user.id, email: user.email, roles: user.roles ?? [] };
}

async function call(env: ThemeEnv, actor: ActingUser, request: Request, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await m2mFetch(env, `/admin/themes${path}`, actor, init, request);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let details: Issue[] | undefined;
    try {
      const body = (await response.json()) as { error?: string; error_description?: string; details?: Issue[] };
      message = body.error_description || body.error || message;
      details = body.details;
    } catch {
      // not JSON
    }
    throw new ThemeApiError(response.status, message, details);
  }
  return response;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

export function themesApi(env: ThemeEnv, actor: ActingUser, request: Request) {
  const c = (path: string, init?: RequestInit) => call(env, actor, request, path, init);
  return {
    list: async () => (await (await c('')).json()) as ThemeList,
    get: async (id: string, source: 'draft' | 'published' = 'draft') =>
      (await (await c(`/${encodeURIComponent(id)}?source=${source}`)).json()) as ThemeDetail,
    duplicate: async (from: string, id: string, name: { en: string; ar: string }) =>
      (await (await c(`/${encodeURIComponent(from)}/duplicate`, { method: 'POST', ...json({ id, name }) })).json()) as ThemeSummary,
    saveDraft: async (id: string, theme: unknown) =>
      (await (await c(`/${encodeURIComponent(id)}/draft`, { method: 'PUT', ...json({ theme }) })).json()) as ThemeSummary & { contrast: Issue[] },
    publish: async (id: string) => (await (await c(`/${encodeURIComponent(id)}/publish`, { method: 'POST' })).json()) as ThemeSummary,
    remove: async (id: string) => {
      await c(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    setAuthDefault: async (themeId: string) => {
      await c('/default', { method: 'POST', ...json({ themeId }) });
    },
    setClientDefault: async (clientId: string, themeId: string | null) => {
      await c(`/clients/${encodeURIComponent(clientId)}`, { method: 'PUT', ...json({ themeId }) });
    },
    uploadAsset: async (id: string, path: string, data: ArrayBuffer, type: string) =>
      (await (await c(`/${encodeURIComponent(id)}/assets?path=${encodeURIComponent(path)}`, { method: 'POST', body: data, headers: { 'Content-Type': type || 'application/octet-stream' } })).json()) as StoredAsset & { path: string },
    removeAsset: async (id: string, path: string) => {
      await c(`/${encodeURIComponent(id)}/assets?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    },
    importZip: async (data: ArrayBuffer, opts: { id?: string; replace?: boolean }) => {
      const q = new URLSearchParams();
      if (opts.id) q.set('id', opts.id);
      if (opts.replace) q.set('replace', '1');
      return (await (await c(`/import?${q}`, { method: 'POST', body: data, headers: { 'Content-Type': 'application/zip' } })).json()) as ThemeSummary;
    },
    exportZip: (id: string, source: 'draft' | 'published') => c(`/${encodeURIComponent(id)}/export?source=${source}`),
    preview: async (body: { theme?: unknown; themeId?: string; page: string; lang: string; scheme: string }) =>
      (await c('/preview', { method: 'POST', ...json(body) })).text(),
  };
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong');
