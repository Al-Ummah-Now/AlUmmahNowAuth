// providers.ts - OAuth provider configuration management

export interface OAuthProviderConfig {
  id: string;
  provider_name: string;
  enabled: boolean;
  client_id?: string;
  client_secret?: string;
  scopes: string[];
  config: Record<string, any>;
  created_at: string;
  updated_at: string;
}

/**
 * Get all OAuth provider configurations from database
 */
export async function getOAuthProviders(env: Env): Promise<OAuthProviderConfig[]> {
  const result = await env.AUTH_DB.prepare(`
    SELECT id, provider_name, enabled, client_id, client_secret, scopes, config, created_at, updated_at
    FROM oauth_providers
    ORDER BY provider_name
  `).all<{
    id: string;
    provider_name: string;
    enabled: number; // SQLite stores boolean as integer
    client_id: string | null;
    client_secret: string | null;
    scopes: string;
    config: string;
    created_at: string;
    updated_at: string;
  }>();

  return (result.results || []).map(row => ({
    id: row.id,
    provider_name: row.provider_name,
    enabled: !!row.enabled,
    client_id: row.client_id || undefined,
    client_secret: row.client_secret || undefined,
    scopes: JSON.parse(row.scopes || '[]'),
    config: JSON.parse(row.config || '{}'),
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

/**
 * Get a specific OAuth provider configuration by name
 */
export async function getOAuthProvider(env: Env, providerName: string): Promise<OAuthProviderConfig | null> {
  const result = await env.AUTH_DB.prepare(`
    SELECT id, provider_name, enabled, client_id, client_secret, scopes, config, created_at, updated_at
    FROM oauth_providers
    WHERE provider_name = ?
  `).bind(providerName).first<{
    id: string;
    provider_name: string;
    enabled: number;
    client_id: string | null;
    client_secret: string | null;
    scopes: string;
    config: string;
    created_at: string;
    updated_at: string;
  }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    provider_name: result.provider_name,
    enabled: !!result.enabled,
    client_id: result.client_id || undefined,
    client_secret: result.client_secret || undefined,
    scopes: JSON.parse(result.scopes || '[]'),
    config: JSON.parse(result.config || '{}'),
    created_at: result.created_at,
    updated_at: result.updated_at
  };
}

/**
 * Update OAuth provider configuration
 */
export async function updateOAuthProvider(
  env: Env, 
  providerName: string, 
  updates: Partial<Pick<OAuthProviderConfig, 'enabled' | 'client_id' | 'client_secret' | 'scopes' | 'config'>>
): Promise<boolean> {
  const sets = [];
  const params = [];

  if (updates.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(updates.enabled ? 1 : 0);
  }
  if (updates.client_id !== undefined) {
    sets.push('client_id = ?');
    params.push(updates.client_id);
  }
  if (updates.client_secret !== undefined) {
    sets.push('client_secret = ?');
    params.push(updates.client_secret);
  }
  if (updates.scopes !== undefined) {
    sets.push('scopes = ?');
    params.push(JSON.stringify(updates.scopes));
  }
  if (updates.config !== undefined) {
    sets.push('config = ?');
    params.push(JSON.stringify(updates.config));
  }

  if (sets.length === 0) {
    return false;
  }

  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(providerName);

  const query = `
    UPDATE oauth_providers 
    SET ${sets.join(', ')}
    WHERE provider_name = ?
  `;

  const result = await env.AUTH_DB.prepare(query).bind(...params).run();
  return result.changes > 0;
}

/**
 * Get enabled OAuth providers for OpenAuth configuration
 */
export async function getEnabledOAuthProviders(env: Env): Promise<OAuthProviderConfig[]> {
  const providers = await getOAuthProviders(env);
  return providers.filter(p => p.enabled && p.client_id && p.client_secret);
}