import { describe, it, expect, vi } from 'vitest';
import { createAdminCountCache } from '../services/admin-count-cache';

describe('createAdminCountCache', () => {
  it('does not cache failed reads and retries cleanly on the next call', async () => {
    const cache = createAdminCountCache<number>();
    const db = {} as D1Database;
    const load = vi.fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('d1 transient'))
      .mockResolvedValueOnce(42);

    await expect(cache.get(db, ['default'], load)).rejects.toThrow('d1 transient');
    await expect(cache.get(db, ['default'], load)).resolves.toBe(42);
    await expect(cache.get(db, ['default'], load)).resolves.toBe(42);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not share an in-flight promise across callers', async () => {
    const cache = createAdminCountCache<number>();
    const db = {} as D1Database;
    let resolveFirst!: (n: number) => void;
    const firstPending = new Promise<number>((resolve) => { resolveFirst = resolve; });
    const load = vi.fn<() => Promise<number>>()
      .mockReturnValueOnce(firstPending)
      .mockResolvedValueOnce(7);

    const p1 = cache.get(db, ['default'], load);
    await expect(cache.get(db, ['default'], load)).resolves.toBe(7);
    expect(load).toHaveBeenCalledTimes(2);
    resolveFirst(7);
    await expect(p1).resolves.toBe(7);
  });

  it('bounds cache size at 128 entries by evicting the oldest key', async () => {
    const cache = createAdminCountCache<number>();
    const db = {} as D1Database;
    const load = vi.fn<() => Promise<number>>().mockResolvedValue(1);

    for (let i = 0; i < 129; i++) {
      await cache.get(db, [`k-${i}`], load);
    }
    expect(load).toHaveBeenCalledTimes(129);

    // Key 1..128 remain cached
    await cache.get(db, ['k-128'], load);
    expect(load).toHaveBeenCalledTimes(129);

    // Key 0 was evicted when key 128 was inserted
    await cache.get(db, ['k-0'], load);
    expect(load).toHaveBeenCalledTimes(130);
  });

  it('does not repopulate the cache from an in-flight load after clear()', async () => {
    const cache = createAdminCountCache<number>();
    const db = {} as D1Database;
    let resolveSlow!: (n: number) => void;
    const slow = new Promise<number>((resolve) => { resolveSlow = resolve; });
    const load = vi.fn<() => Promise<number>>()
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce(99);

    const p1 = cache.get(db, ['default'], load);
    cache.clear();
    resolveSlow(1);
    await expect(p1).resolves.toBe(1);

    await expect(cache.get(db, ['default'], load)).resolves.toBe(99);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
