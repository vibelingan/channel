import { createHash, randomUUID } from 'node:crypto';
import { verifyReleaseArtifact } from './release/artifact.mjs';
import {
  assertHostingPath,
  assertOrigin,
  checkEntries,
  freeze,
  identity,
  isSitemap,
  limits,
  productPath,
  readObject,
} from './release/input.mjs';
import { readPublicOutput } from './release/public-output.mjs';
export { assertHostingPath } from './release/input.mjs';

const hash = (algorithm, body) => createHash(algorithm).update(body).digest('hex');
const protectedPath =
  /^(?:__auth\/|\.cloudbase-backup\/|google[a-z0-9]+\.html$|BingSiteAuth\.xml$)/;
const isDiscovery = (path) =>
  isSitemap(path) || /^(?:robots\.txt|seo-manifest\.json|products\/manifest\.json)$/.test(path);

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

export function inventoryIdentity(entries) {
  if (!Array.isArray(entries) || entries.length > limits.files)
    throw new Error('Inventory count limit exceeded.');
  const seen = new Set();
  let bytes = 0;
  return entries
    .filter((entry) => !entry.path.endsWith('/'))
    .map((entry) => {
      assertHostingPath(entry.path);
      if (seen.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
        throw new Error('Invalid or duplicate hosting inventory entry.');
      bytes += entry.bytes;
      if (entry.bytes > limits.fileBytes || bytes > limits.totalBytes)
        throw new Error('Inventory byte limit exceeded.');
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
  assertOrigin(before.site);
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
  assertOrigin(target.site);
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
  checkEntries(manifest.entries);
  const seen = new Set();
  for (const entry of manifest.entries) {
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
  return makePlan({
    entries: manifest.entries,
    configurationSha256: manifest.configurationSha256,
    directory,
    target,
    scope: { kind: 'site' },
    currentOwnedPaths,
    publicProductPaths,
  });
}

/** V2 has its own source/seal checks; a legacy v1 backup is never promoted to v2. */
export function planReleaseRecovery({ artifactInput, currentOwnedPaths, publicProductPaths }) {
  const { envelope, staticManifest } = verifyReleaseArtifact({
    ...artifactInput,
    mode: 'recovery',
  });
  return makePlan({
    entries: staticManifest.entries,
    configurationSha256: staticManifest.configurationSha256,
    directory: artifactInput.directory,
    target: { envId: envelope.target.envId, site: envelope.target.siteOrigin },
    scope: envelope.scope,
    currentOwnedPaths,
    publicProductPaths,
  });
}

function makePlan({
  entries,
  configurationSha256,
  directory,
  target,
  scope,
  currentOwnedPaths,
  publicProductPaths,
}) {
  if (!Array.isArray(currentOwnedPaths) || !Array.isArray(publicProductPaths))
    throw new Error('Current ownership and a fresh public product allowlist are required.');
  if (
    currentOwnedPaths.length > limits.files ||
    publicProductPaths.length > limits.urls ||
    new Set(publicProductPaths).size !== publicProductPaths.length
  )
    throw new Error('Invalid ownership/public evidence count limit or duplicate.');
  const publicPaths = new Set(publicProductPaths);
  for (const path of publicPaths) {
    if (!productPath.test(path)) throw new Error('Invalid current public product path.');
  }
  const publicOutput =
    scope.kind === 'canary'
      ? { products: [], legacy: false }
      : readPublicOutput(directory, entries, target.site, publicProductPaths);
  const owned = [...new Set(currentOwnedPaths.map(assertHostingPath))];
  if (scope.kind === 'canary' && owned.some((path) => !path.startsWith(scope.prefix)))
    throw new Error('Owned paths escape canary scope.');
  const restored = entries.filter((entry) => !protectedPath.test(entry.path));
  const restoredPaths = new Set(restored.map((entry) => entry.path));
  for (const path of owned) {
    if (
      path.toLowerCase().endsWith('.xml') &&
      !protectedPath.test(path) &&
      !restoredPaths.has(path) &&
      !isDiscovery(path)
    )
      throw new Error(`Unclassified owned XML path requires discovery ownership proof: ${path}`);
  }
  const phase = (entry) =>
    isDiscovery(entry.path) || publicOutput.discoveryPaths?.includes(entry.path)
      ? 2
      : entry.path.endsWith('.html')
        ? 1
        : 0;
  const plan = {
    schemaVersion: 2,
    target,
    configurationSha256,
    scope,
    publicOutput,
    uploads: restored.sort((a, b) => phase(a) - phase(b) || a.path.localeCompare(b.path)),
    deletes: owned.filter(
      (path) =>
        !protectedPath.test(path) &&
        !restoredPaths.has(path) &&
        (path.endsWith('.html') || isDiscovery(path)),
    ),
    preservedPlatformFiles: entries.filter((entry) => protectedPath.test(entry.path)).length,
  };
  plan.stateSha256 = recoveryStateIdentity(plan);
  return freeze(structuredClone({ ...plan, planSha256: identity(plan) }));
}

/** Adapters run under the environment lock; this kernel never chooses a recovery target. */
export async function executeHostingRecovery(input, inputAdapters) {
  const adapters = Object.freeze({ ...inputAdapters });
  // Copy before the first await so the caller cannot change a queued operation.
  const plan = freeze(structuredClone(input));
  const { planSha256, ...body } = plan;
  if (
    plan.schemaVersion !== 2 ||
    planSha256 !== identity(body) ||
    plan.stateSha256 !== recoveryStateIdentity(plan)
  )
    throw new Error('Invalid recovery plan identity.');
  for (const name of ['upload', 'verify', 'remove', 'configure', 'accept'])
    if (typeof adapters[name] !== 'function') throw new Error(`Missing recovery adapter: ${name}`);
  const executionId = randomUUID();
  const context = (subject, expectedHash) =>
    freeze({ executionId, planSha256, subject, expectedHash });
  const receipts = [];
  for (const entry of plan.uploads) {
    const intent = context(`upload:${entry.path}`, entry.sha256);
    const write = await adapters.upload(entry, intent);
    assertReceipt(write, intent, 'submitted');
    const read = { ...context(`read:${entry.path}`, entry.sha256), operationId: write.operationId };
    const receipt = await adapters.verify(entry, freeze(read));
    assertReceipt(receipt, read, 'verified');
    receipts.push(receipt);
  }
  for (const path of plan.deletes) {
    const intent = context(`remove:${path}`, 'absent');
    const receipt = await adapters.remove(path, intent);
    assertReceipt(receipt, intent, 'verified');
    receipts.push(receipt);
  }
  const config = context('configure', plan.configurationSha256);
  const configured = await adapters.configure(config);
  assertReceipt(configured, config, 'verified');
  receipts.push(configured);
  const acceptance = context('accept', plan.stateSha256);
  const accepted = await adapters.accept(acceptance);
  assertReceipt(accepted, acceptance, 'verified');
  receipts.push(accepted);
  return freeze(
    structuredClone({
      status: 'verified',
      executionId,
      planSha256,
      stateSha256: plan.stateSha256,
      restored: plan.uploads.length,
      removed: plan.deletes.length,
      receipts,
    }),
  );
}

export function recoveryStateIdentity(plan) {
  return identity({
    target: plan.target,
    scope: plan.scope,
    files: plan.uploads
      .map(({ path, sha256 }) => ({ path, sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    absent: [...plan.deletes].sort(),
    configurationSha256: plan.configurationSha256,
  });
}

function assertReceipt(receipt, expected, status) {
  if (
    receipt?.status !== status ||
    receipt.executionId !== expected.executionId ||
    typeof receipt.operationId !== 'string' ||
    !receipt.operationId.trim() ||
    receipt.operationId.length > 256 ||
    receipt.planSha256 !== expected.planSha256 ||
    receipt.subject !== expected.subject ||
    receipt.expectedHash !== expected.expectedHash ||
    (expected.operationId !== undefined && receipt.operationId !== expected.operationId) ||
    (status === 'verified' && receipt.observedHash !== expected.expectedHash)
  )
    throw new Error(`Unverified recovery receipt: ${expected.subject}`);
}
