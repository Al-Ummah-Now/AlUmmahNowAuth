import { describe, it, expect } from 'vitest';
import { adminErrorResponse, safeErrorMessage } from '../utils/error-response';

describe('error response helpers', () => {
  it('adminErrorResponse hides internal error messages behind a generic 500', async () => {
    const res = adminErrorResponse(new Error('D1_ERROR: no such column: secret_hash'), 'Failed to get metrics');
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Failed to get metrics');
    expect(JSON.stringify(body)).not.toContain('D1_ERROR');
  });

  it('adminErrorResponse maps auth failures to a generic 401', async () => {
    const res = adminErrorResponse(new Error('Authentication required: JWSSignatureVerificationFailed'), 'x');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Authentication required', status: 401 });
  });

  it('safeErrorMessage only passes allow-listed messages through', () => {
    const allowed = ['Tenant not found'];
    expect(safeErrorMessage(new Error('Tenant not found'), 'Failed', allowed)).toBe('Tenant not found');
    expect(safeErrorMessage(new Error('SQLITE_CONSTRAINT: UNIQUE failed: tenants.id'), 'Failed', allowed)).toBe('Failed');
    expect(safeErrorMessage('nope', 'Failed', allowed)).toBe('Failed');
  });
});
