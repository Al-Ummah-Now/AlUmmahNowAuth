import { describe, expect, it } from 'vitest';
import { confirmCopy, type ConfirmCopy } from './confirm-copy';

/** Every leaf string (or function output) of a copy object, by path. */
function leaves(copy: unknown, path = ''): Record<string, string> {
  if (typeof copy === 'string') return { [path]: copy };
  if (typeof copy === 'function') return { [path]: (copy as (...a: string[]) => string)('A', 'B') };
  return Object.entries(copy as object).reduce(
    (all, [key, value]) => ({ ...all, ...leaves(value, path ? `${path}.${key}` : key) }),
    {} as Record<string, string>,
  );
}

describe('confirm copy', () => {
  it('has every string in both languages, and Arabic differs from English', () => {
    const en = leaves(confirmCopy('en'));
    const ar = leaves(confirmCopy('ar'));
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(ar[key], key).toBeTruthy();
      expect(ar[key], key).not.toBe(en[key]);
    }
  });

  it('puts the names it is given into the text, in both languages', () => {
    for (const copy of [confirmCopy('en'), confirmCopy('ar')] as ConfirmCopy[]) {
      expect(copy.removeRole.body('u@example.com', 'Editor')).toContain('u@example.com');
      expect(copy.removeRole.body('u@example.com', 'Editor')).toContain('Editor');
      expect(copy.rotateSecret.body('App', 'cid-1')).toContain('cid-1');
      expect(copy.deletesAccount('u@example.com')).toContain('u@example.com');
    }
  });

  it('keeps the English confirm labels the E2E clicks', () => {
    expect(confirmCopy('en').approve.confirm).toBe('Approve');
    expect(confirmCopy('en').execute.confirm).toBe('Run action again');
  });
});
