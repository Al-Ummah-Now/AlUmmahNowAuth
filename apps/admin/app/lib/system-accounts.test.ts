import { describe, expect, it } from 'vitest';
import { actorLabel, isSuperAdmin, isSystemUserId, systemAccountsCopy } from './system-accounts';

describe('system accounts in the admin', () => {
  it('shows "assigned by user_system" as System (automatic), in English and Arabic', () => {
    expect(actorLabel('user_system', 'en')).toBe('System (automatic)');
    expect(actorLabel('user_system', 'ar')).toBe('النظام (تلقائي)');
    expect(actorLabel(null, 'en')).toBe('System (automatic)');
    expect(actorLabel('usr_abc', 'en')).toBe('usr_abc');
  });

  it('knows the system account ids', () => {
    expect(isSystemUserId('user_system')).toBe(true);
    expect(isSystemUserId('usr_abc')).toBe(false);
    expect(isSystemUserId(undefined)).toBe(false);
  });

  it('only super admins get the System accounts view', () => {
    expect(isSuperAdmin(['Super Admin'])).toBe(true);
    expect(isSuperAdmin(['super_admin'])).toBe(true);
    expect(isSuperAdmin(['Admin', 'Member'])).toBe(false);
    expect(isSuperAdmin(undefined)).toBe(false);
  });

  it('labels them as unable to sign in in both languages', () => {
    expect(systemAccountsCopy('en').cantSignIn).toBe("Can't sign in");
    expect(systemAccountsCopy('ar').cantSignIn).toBe('لا يمكنه تسجيل الدخول');
    for (const lang of ['en', 'ar'] as const) {
      const copy = systemAccountsCopy(lang);
      for (const value of Object.values(copy)) expect(value.length).toBeGreaterThan(0);
    }
  });
});
