import { describe, expect, it } from 'vitest';
import { signingKeysCopy } from './signing-keys-copy';
import { shellCopy } from './shell-copy';

describe('signing keys copy (AlUmmahNowAuth#13)', () => {
  it('has every string in both languages', () => {
    const en = signingKeysCopy('en');
    const ar = signingKeysCopy('ar');
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(typeof ar[key]).toBe(typeof en[key]);
      if (typeof en[key] === 'string' && en[key] !== '—') expect(ar[key]).not.toBe(en[key]);
    }
    for (const group of ['state', 'stateHelp', 'errors'] as const) {
      expect(Object.keys(ar[group]).sort()).toEqual(Object.keys(en[group]).sort());
    }
    expect(shellCopy('en').nav.signingKeys).toBe('Signing keys');
    expect(shellCopy('ar').nav.signingKeys).toBe('مفاتيح التوقيع');
  });

  it('states the policy with the configured numbers, and whether rotation is automatic', () => {
    const on = signingKeysCopy('en').policy({ leadHours: 1, rotateDays: 90, retireHours: 24, scheduled: true });
    expect(on[0]).toContain('1 hour before');
    expect(on[1]).toContain('24 hours after');
    expect(on[2]).toContain('90 days');
    const off = signingKeysCopy('en').policy({ leadHours: 1, rotateDays: 90, retireHours: 24, scheduled: false });
    expect(off[2]).toContain('Automatic rotation is off');
    const ar = signingKeysCopy('ar').policy({ leadHours: 1, rotateDays: 90, retireHours: 24, scheduled: false });
    expect(ar[0]).toContain('ساعة واحدة');
    expect(ar[1]).toContain('٢٤ ساعة');
    // Arabic numbers in ٠–٩, never 0–9
    const arOn = signingKeysCopy('ar').policy({ leadHours: 48, rotateDays: 30, retireHours: 336, scheduled: true });
    expect(arOn.join(' ')).toContain('٤٨ ساعة');
    expect(arOn.join(' ')).toContain('٣٣٦ ساعة');
    expect(arOn.join(' ')).toContain('٣٠ يومًا');
    for (const text of arOn) expect(text).not.toMatch(/[0-9]/);
    expect(signingKeysCopy('ar').failedBody('x', 2)).toContain('محاولتين');
  });
});
