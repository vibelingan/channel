import { createHash } from 'node:crypto';

/**
 * Schema 2 recovery copies split a site payload into objects so a deploy uploads only
 * what changed: a head with the per-run files, large files alone, and the rest in
 * packs chosen by a hash of the path. Each record stores its layout, so these numbers
 * can change later without breaking older records.
 *
 * Objects are shared by every record whose members are identical. Nothing may delete
 * one without counting references across all records (see docs/agents/cloudbase.md).
 */
export const SITE_PACK_LAYOUT = Object.freeze({
  kind: 'site-packs',
  version: 1,
  packs: 32,
  soloBytes: 512 * 1024,
});
const HEAD = new Set(['payload-manifest.json', 'compatibility.json']);
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function checkSitePackLayout(layout) {
  if (
    layout?.kind !== 'site-packs' ||
    layout.version !== 1 ||
    !Number.isSafeInteger(layout.packs) ||
    layout.packs < 1 ||
    layout.packs > 256 ||
    !Number.isSafeInteger(layout.soloBytes) ||
    layout.soloBytes < 1024
  )
    throw Error('Unsupported recovery archive layout');
  return {
    kind: layout.kind,
    version: layout.version,
    packs: layout.packs,
    soloBytes: layout.soloBytes,
  };
}

/** Pure: the same manifest and layout always give the same objects and content ids. */
export function planSitePacks({ entries, manifest, layout = SITE_PACK_LAYOUT }) {
  const checked = checkSitePackLayout(layout);
  const member = (path, bytes, sha256) => {
    if (
      typeof path !== 'string' ||
      !path ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(sha256 ?? '')
    )
      throw Error('Invalid recovery archive member');
    return [path, bytes, sha256];
  };
  if (!Array.isArray(entries) || !entries.length) throw Error('Recovery archive needs members');
  const groups = new Map([
    ['head', [member('payload-manifest.json', manifest?.bytes, manifest?.sha256)]],
  ]);
  const seen = new Set(['payload-manifest.json']);
  for (const entry of entries) {
    const value = member(entry?.path, entry?.bytes, entry?.sha256);
    if (seen.has(value[0])) throw Error('Duplicate recovery archive member');
    seen.add(value[0]);
    const key = HEAD.has(value[0])
      ? 'head'
      : value[1] >= checked.soloBytes
        ? `solo:${value[0]}`
        : `pack:${Number.parseInt(hash(value[0]).slice(0, 8), 16) % checked.packs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return [...groups]
    .map(([key, members]) => {
      members.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      return {
        key,
        members,
        contentSha256: hash(JSON.stringify({ version: checked.version, key, members })),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}
