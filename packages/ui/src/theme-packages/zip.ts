// Theme packages as .zip files: write (stored, no compression; images are compressed already)
// and read (stored or deflate, through the platform's DecompressionStream). No dependencies.
import type { PackageFiles, ThemePackage } from './types.ts';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = new TextEncoder();

/** A zip of the files, in the order given. Names use forward slashes. */
export function createZip(files: Record<string, Uint8Array>): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = utf8.encode(name);
    const crc = crc32(data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true); // UTF-8 names
    header.setUint16(8, 0, true); // stored
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, nameBytes.length, true);
    local.push(new Uint8Array(header.buffer), nameBytes, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Inflates at most `limit` bytes: a zip bomb is stopped as soon as it outgrows its declared size. */
async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('a file in the zip is larger than it says');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export const MAX_ZIP_ENTRIES = 300;
export const MAX_UNZIPPED_BYTES = 16 * 1024 * 1024;

/** Every file in a zip. Rejects encryption, zip64, unknown methods and archives that inflate past 16 MB. */
export async function readZip(zip: Uint8Array): Promise<Record<string, Uint8Array>> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const count = view.getUint16(end + 10, true);
  if (count > MAX_ZIP_ENTRIES) throw new Error(`the zip has ${count} files; the limit is ${MAX_ZIP_ENTRIES}`);
  let at = view.getUint32(end + 16, true);
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('the zip is damaged');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new Error('encrypted zips are not supported');
    if (name.endsWith('/')) continue;
    if (size === 0xffffffff || compSize === 0xffffffff) throw new Error('zip64 archives are not supported');
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new Error('the package is larger than 16 MB unzipped');
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    if (dataAt + compSize > zip.length) throw new Error(`${name} is damaged`);
    const compressed = zip.subarray(dataAt, dataAt + compSize);
    let data: Uint8Array;
    if (method === 0) data = compressed.slice();
    else if (method === 8) data = await inflateRaw(compressed, size);
    else throw new Error(`zip compression method ${method} is not supported`);
    if (data.length !== size) throw new Error(`${name} is damaged`);
    files[name] = data;
  }
  return files;
}

/** A package as a zip: <id>/theme.json and <id>/assets/... */
export function packageToZip({ theme, assets }: PackageFiles): Uint8Array {
  const files: Record<string, Uint8Array> = { [`${theme.id}/theme.json`]: utf8.encode(`${JSON.stringify(theme, null, 2)}\n`) };
  for (const [path, bytes] of Object.entries(assets).sort(([a], [b]) => a.localeCompare(b))) files[`${theme.id}/${path}`] = bytes;
  return createZip(files);
}

/**
 * A package from a zip: theme.json at the root, or inside one top-level folder. Files outside
 * assets/ (other than theme.json) and macOS metadata are ignored. theme.json is parsed but not validated.
 */
export async function zipToPackage(zip: Uint8Array): Promise<PackageFiles> {
  const all = Object.entries(await readZip(zip)).filter(([name]) => !name.startsWith('__MACOSX/') && !name.split('/').pop()!.startsWith('.'));
  const themeEntry = all.find(([name]) => /^(?:[^/]+\/)?theme\.json$/.test(name));
  if (!themeEntry) throw new Error('the zip has no theme.json (at the root or in one folder)');
  const prefix = themeEntry[0].slice(0, -'theme.json'.length);
  let theme: ThemePackage;
  try { theme = JSON.parse(new TextDecoder().decode(themeEntry[1])); } catch { throw new Error('theme.json is not valid JSON'); }
  const assets: Record<string, Uint8Array> = {};
  for (const [name, bytes] of all) {
    if (!name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    if (rel.startsWith('assets/')) {
      if (rel.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`${rel} is not an allowed path`);
      assets[rel] = bytes;
    }
  }
  return { theme, assets };
}
