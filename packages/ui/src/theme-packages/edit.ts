// Small edits a theme builder makes: duplicating a package and bumping its version.
import type { Localized, ThemePackage } from './types.ts';

export const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/** A standalone copy under a new id and name, at 1.0.0, marked custom and based on the source. */
export function duplicatePackage(source: ThemePackage, id: string, name: Localized, author: string): ThemePackage {
  if (!ID_PATTERN.test(id)) throw new Error('id must be 2-40 lowercase letters, digits or dashes, starting with a letter');
  const copy = structuredClone(source);
  delete copy.$schema;
  return { ...copy, id, name, author, version: '1.0.0', kind: 'custom', basedOn: `${source.id}@${source.version}` };
}

/** The next version after the given ones: one minor step past the highest. */
export function nextVersion(existing: string[]): string {
  if (!existing.length) return '1.0.0';
  const parse = (v: string) => v.split('.').map(Number) as [number, number, number];
  const [major, minor] = existing.map(parse).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
  return `${major}.${minor + 1}.0`;
}
