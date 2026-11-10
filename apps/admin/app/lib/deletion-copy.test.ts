import { describe, expect, it } from 'vitest';
import { daysUntil, deletionCopy, dirOf, langOf, RETENTION_DAYS } from './deletion-copy';

const DAY = 24 * 60 * 60 * 1000;

describe('deletion copy', () => {
  it('is English unless ?lang=ar', () => {
    expect(langOf('')).toBe('en');
    expect(langOf('?lang=fr')).toBe('en');
    expect(langOf('?lang=ar')).toBe('ar');
    expect(dirOf('ar')).toBe('rtl');
  });

  it('counts whole days left until the cleanup, never below zero', () => {
    const now = 1_000_000_000_000;
    expect(daysUntil(now + RETENTION_DAYS * DAY, now)).toBe(30);
    expect(daysUntil(now + 1, now)).toBe(1);
    expect(daysUntil(now - DAY, now)).toBe(0);
    expect(deletionCopy('en').daysLeft(0)).toBe('On the next cleanup run');
  });

  it('has every string in both languages', () => {
    const en = deletionCopy('en');
    const ar = deletionCopy('ar');
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(typeof ar[key]).toBe(typeof en[key]);
      if (typeof en[key] === 'string') expect(ar[key]).not.toBe(en[key]);
    }
    expect(ar.deleteBody('user', 'x')).toContain('x');
  });
});
