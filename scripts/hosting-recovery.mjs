import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const hash = (algorithm, body) => createHash(algorithm).update(body).digest('hex');
const productFile = /^products\/p-[A-Za-z0-9_-]{1,200}\/index\.html$/;
const protectedPath =
  /^(?:__auth\/|\.cloudbase-backup\/|google[a-z0-9]+\.html$|BingSiteAuth\.xml$)/;
const discovery =
  /^(?:sitemap-[^/]+\.xml|robots\.txt|seo-manifest\.json|products\/manifest\.json)$/;

/** Exclude request IDs, response timestamps and reachability probes from identity. */
export function hostingConfigurationIdentity(config) {
  const website = config.website;
  const gateway = config.gateway;
  if (!website?.WebsiteConfiguration?.IndexDocument?.Suffix || !gateway?.Domains?.length)
    throw new Error('Incomplete hosting configuration.');
  return {
    website: {
      WebsiteConfiguration: website.WebsiteConfiguration,
      Bucket: website.Bucket,
      CdnDomain: website.CdnDomain,
    },
    gateway: { Domains: gateway.Domains, OriginDomain: gateway.OriginDomain },
  };
}

export function assertHostingPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /[%?#]/u.test(path) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid hosting object path.');
  return path;
}

function readObject(directory, path) {
  assertHostingPath(path);
  const root = realpathSync(directory);
  const file = resolve(root, path);
  // Reject symlinks at every level, including ones pointing back into the backup.
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = resolve(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink in recovery input: ${path}`);
  }
  if (!realpathSync(file).startsWith(`${root}${sep}`) || !lstatSync(file).isFile())
    throw new Error(`Not a regular recovery file: ${path}`);
  return readFileSync(file);
}

export function inventoryIdentity(entries) {
  const seen = new Set();
  return entries
    .filter((entry) => !entry.path.endsWith('/'))
    .map((entry) => {
      assertHostingPath(entry.path);
      if (seen.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
        throw new Error('Invalid or duplicate hosting inventory entry.');
      seen.add(entry.path);
      if (!entry.etag || !entry.lastModified) throw new Error('Missing inventory version.');
      return [entry.path, entry.bytes, entry.etag, entry.lastModified];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Seal only after a second complete inventory proves the download saw a stable version. */
export function sealHostingBackup({
  directory,
  before,
  after,
  configBefore,
  configAfter,
  contentProofs = [],
}) {
  const configuration = hostingConfigurationIdentity(configBefore);
  if (
    before.envId !== after.envId ||
    before.site !== after.site ||
    !before.envId ||
    new URL(before.site).origin !== before.site ||
    JSON.stringify(inventoryIdentity(before.entries)) !==
      JSON.stringify(inventoryIdentity(after.entries)) ||
    JSON.stringify(configuration) !== JSON.stringify(hostingConfigurationIdentity(configAfter))
  )
    throw new Error('Hosting changed during backup; capture again before any write.');
  const entries = inventoryIdentity(before.entries).map(([path, bytes, etag]) => {
    const body = readObject(directory, path);
    if (body.length !== bytes) throw new Error(`Backup size mismatch: ${path}`);
    const md5 = etag.replaceAll('"', '');
    if (/^[a-f0-9]{32}$/i.test(md5)) {
      if (hash('md5', body) !== md5.toLowerCase()) throw new Error(`Backup ETag mismatch: ${path}`);
    } else {
      // Multipart ETags are not content MD5s. Require an independent HTTP read
      // with the exact inventory ETag, byte length and downloaded body SHA-256.
      const proof = contentProofs.find((item) => item.path === path);
      if (proof?.etag !== etag || proof?.bytes !== bytes || proof?.sha256 !== hash('sha256', body))
        throw new Error(`Cannot prove backup content against the object ETag: ${path}`);
    }
    return { path, bytes, sha256: hash('sha256', body) };
  });
  if (!entries.some((entry) => entry.path === 'index.html')) throw new Error('Empty site backup.');
  return {
    schemaVersion: 1,
    purpose: 'hosting-recovery',
    envId: before.envId,
    site: before.site,
    capturedAt: new Date().toISOString(),
    source: 'online-backup',
    entries,
    configuration,
    configurationSha256: hash('sha256', JSON.stringify(configuration)),
  };
}

export function verifyRecoveryInput(manifest, directory, target) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.purpose !== 'hosting-recovery' ||
    manifest.envId !== target.envId ||
    manifest.site !== target.site ||
    !Array.isArray(manifest.entries) ||
    !manifest.entries.length ||
    manifest.configurationSha256 !== hash('sha256', JSON.stringify(manifest.configuration))
  )
    throw new Error('Incomplete, corrupt or wrong-environment recovery input.');
  const seen = new Set();
  for (const entry of manifest.entries) {
    assertHostingPath(entry.path);
    if (
      seen.has(entry.path) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error('Invalid or duplicate recovery entry.');
    seen.add(entry.path);
    const body = readObject(directory, entry.path);
    if (body.length !== entry.bytes || hash('sha256', body) !== entry.sha256)
      throw new Error(`Corrupt recovery file: ${entry.path}`);
  }
  if (!seen.has('index.html')) throw new Error('Recovery input has no homepage.');
}

/** No broad pruning. Only explicitly owned HTML/discovery files can be removed. */
export function planHostingRecovery({
  manifest,
  directory,
  target,
  currentOwnedPaths,
  publicProductPaths,
}) {
  verifyRecoveryInput(manifest, directory, target);
  if (!Array.isArray(currentOwnedPaths) || !Array.isArray(publicProductPaths))
    throw new Error('Current ownership and a fresh public product allowlist are required.');
  const publicPaths = new Set(publicProductPaths);
  for (const path of publicPaths) {
    if (!/^\/products\/p-[A-Za-z0-9_-]{1,200}\/$/.test(path))
      throw new Error('Invalid current public product path.');
  }
  // Reject the whole input instead of merely skipping withdrawn HTML: its old
  // sitemap/manifest could otherwise still advertise withdrawn products.
  for (const entry of manifest.entries) {
    if (productFile.test(entry.path) && !publicPaths.has(`/${entry.path.slice(0, -10)}`))
      throw new Error(`Recovery would resurrect a withdrawn product: ${entry.path}`);
  }
  const owned = [...new Set(currentOwnedPaths.map(assertHostingPath))];
  const restored = manifest.entries.filter((entry) => !protectedPath.test(entry.path));
  const restoredPaths = new Set(restored.map((entry) => entry.path));
  const phase = (entry) => (discovery.test(entry.path) ? 2 : entry.path.endsWith('.html') ? 1 : 0);
  return {
    schemaVersion: 1,
    target,
    uploads: restored.sort((a, b) => phase(a) - phase(b) || a.path.localeCompare(b.path)),
    deletes: owned.filter(
      (path) =>
        !protectedPath.test(path) &&
        !restoredPaths.has(path) &&
        (path.endsWith('.html') || discovery.test(path)),
    ),
    preservedPlatformFiles: manifest.entries.filter((entry) => protectedPath.test(entry.path))
      .length,
  };
}

/** Adapter must run under the existing environment lock. No install, build or function writes. */
export async function executeHostingRecovery(plan, { upload, verify, remove, configure, accept }) {
  for (const entry of plan.uploads) {
    await upload(entry);
    // Do not advance to HTML if any dependency failed to upload or read back.
    await verify(entry);
  }
  for (const path of plan.deletes) await remove(path);
  await configure();
  await accept();
  return { restored: plan.uploads.length, removed: plan.deletes.length };
}
