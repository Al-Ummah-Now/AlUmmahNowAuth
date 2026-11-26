import { SYSTEM_USER_IDS_SQL } from '../security/system-accounts';

const TTL_MS = 60_000;
const MAX_ENTRIES = 128;

export function createAdminCountCache<T>() {
  type Entry = { expiresAt: number; value: Promise<T> };
  let databases = new WeakMap<D1Database, Map<string, Entry>>();

  return {
    get(db: D1Database, params: readonly (string | number | undefined)[], load: () => Promise<T>): Promise<T> {
      let entries = databases.get(db);
      if (!entries) {
        entries = new Map();
        databases.set(db, entries);
      }

      const key = JSON.stringify(params);
      const hit = entries.get(key);
      if (hit && Date.now() < hit.expiresAt) return hit.value;

      entries.delete(key);
      if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);

      const cache = entries;
      const entry: Entry = {
        expiresAt: Infinity,
        value: Promise.resolve().then(load).then(
          (value) => {
            entry.expiresAt = Date.now() + TTL_MS;
            return value;
          },
          (error) => {
            if (cache.get(key) === entry) cache.delete(key);
            throw error;
          },
        ),
      };
      entries.set(key, entry);
      return entry.value;
    },
    clear() {
      databases = new WeakMap();
    },
  };
}

export const liveUserCount = createAdminCountCache<number>();

export function countLiveUsers(db: D1Database, tenantId: string): Promise<number> {
  return liveUserCount.get(db, [tenantId], async () => {
    const result = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE tenant_id = ?1 AND deleted_at IS NULL)
        - (SELECT COUNT(*) FROM users WHERE id IN (${SYSTEM_USER_IDS_SQL}) AND tenant_id = ?1 AND deleted_at IS NULL)
        AS count
    `).bind(tenantId).first<{ count: number }>();
    return result?.count ?? 0;
  });
}
