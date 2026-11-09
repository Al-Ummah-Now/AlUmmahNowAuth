/**
 * The auth worker must not write log lines to D1: each line cost ~4 rows
 * written and QA reached ~12M rows/day (AlUmmahNowAuth#255).
 */
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';

describe('D1 logging', () => {
  it('writes nothing to the database when disabled', async () => {
    const prepare = vi.fn();
    const batch = vi.fn();
    logger.setDatabase({ prepare, batch } as unknown as D1Database, false);
    logger.info('hello');
    logger.error('boom');
    await new Promise((r) => setTimeout(r, 150));
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
});
