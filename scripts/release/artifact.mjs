import {
  assertHostingPath,
  assertOrigin,
  checkEntries,
  freeze,
  identity,
  isHash,
  isSitemap,
  limits,
  readJson,
  readObject,
  sha256,
} from './input.mjs';

/** Match platform metadata supplied by a trusted adapter; this does not authenticate GitHub. */
export function verifyReleaseArtifact({
  envelope,
  directory,
  policy,
  run,
  acceptedSeal,
  mode = 'recovery',
  now = Date.now(),
}) {
  const e = envelope;
  if (
    !['candidate', 'recovery'].includes(mode) ||
    !Number.isFinite(now) ||
    e?.schemaVersion !== 2 ||
    typeof e.releaseId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(e.releaseId) ||
    !/^[a-f0-9]{40}$/.test(e.codeSha)
  )
    throw new Error('Invalid release envelope schema or identity.');
  assertOrigin(e.target?.siteOrigin);
  if (typeof e.target.envId !== 'string' || !e.target.envId.trim())
    throw new Error('Missing release environment identity.');
  if (
    !policy?.repository ||
    !policy.workflowPath ||
    !policy.event ||
    !policy.ref ||
    identity(e.target) !== identity(policy.target) ||
    identity(e.scope) !== identity(policy.scope)
  )
    throw new Error('Release target/scope policy mismatch.');
  const ref = e.artifact;
  if (
    !ref ||
    ref.repository !== policy.repository ||
    ref.workflowPath !== policy.workflowPath ||
    typeof ref.runId !== 'string' ||
    !/^[1-9][0-9]*$/.test(ref.runId) ||
    typeof ref.artifactId !== 'string' ||
    !/^[1-9][0-9]*$/.test(ref.artifactId) ||
    !isHash(ref.manifestSha256)
  )
    throw new Error('Invalid artifact source reference.');
  const expires = Date.parse(ref.expiresAt);
  if (!Number.isFinite(expires) || expires <= now)
    throw new Error('Artifact expired or missing expiry.');
  if (
    !run ||
    run.repository !== ref.repository ||
    run.workflowPath !== ref.workflowPath ||
    run.event !== policy.event ||
    run.ref !== policy.ref ||
    run.headSha !== e.codeSha ||
    run.runId !== ref.runId ||
    run.artifact?.id !== ref.artifactId ||
    run.artifact.runId !== ref.runId ||
    run.artifact.expired !== false ||
    run.artifact.expiresAt !== ref.expiresAt
  )
    throw new Error('Artifact source metadata mismatch.');
  if (
    mode === 'recovery' &&
    (acceptedSeal?.schemaVersion !== 1 ||
      typeof acceptedSeal.activationId !== 'string' ||
      !acceptedSeal.activationId.trim() ||
      acceptedSeal.releaseId !== e.releaseId ||
      acceptedSeal.codeSha !== e.codeSha ||
      identity(acceptedSeal.artifact) !== identity(ref) ||
      identity(acceptedSeal.target) !== identity(e.target) ||
      identity(acceptedSeal.scope) !== identity(e.scope))
  )
    throw new Error('Missing matching accepted component seal.');
  const bytes = readObject(directory, 'payload-manifest.json', 4 * 1024 * 1024);
  if (sha256(bytes) !== ref.manifestSha256) throw new Error('Payload manifest hash mismatch.');
  const payload = readJson(directory, 'payload-manifest.json');
  if (
    payload.schemaVersion !== 2 ||
    payload.purpose !== 'release-payload' ||
    identity(payload.target) !== identity(e.target) ||
    identity(payload.scope) !== identity(e.scope) ||
    payload.releaseId !== e.releaseId ||
    payload.codeSha !== e.codeSha ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    Date.parse(payload.createdAt) > now + 300_000
  )
    throw new Error('Invalid payload manifest identity or timestamp.');
  for (const key of ['staticManifestPath', 'snapshotPath', 'functions', 'compatibilityRef']) {
    if (
      !Object.hasOwn(payload, key) ||
      !Object.hasOwn(e, key) ||
      identity(payload[key]) !== identity(e[key])
    )
      throw new Error(`Payload component descriptor mismatch: ${key}`);
  }
  checkEntries(payload.entries);
  const files = new Map(payload.entries.map((entry) => [entry.path, entry]));
  for (const entry of payload.entries) {
    const body = readObject(directory, entry.path);
    if (body.length !== entry.bytes || sha256(body) !== entry.sha256)
      throw new Error(`Corrupt payload file: ${entry.path}`);
  }
  const requireFile = (path, expectedHash) => {
    assertHostingPath(path);
    if (
      !files.has(path) ||
      (expectedHash !== undefined &&
        (!isHash(expectedHash) || files.get(path).sha256 !== expectedHash))
    )
      throw new Error(`Missing or mismatched payload member: ${path}`);
  };
  requireFile(e.staticManifestPath);
  const staticManifest = readJson(directory, e.staticManifestPath);
  if (
    staticManifest.schemaVersion !== 2 ||
    staticManifest.purpose !== 'static-release' ||
    staticManifest.configurationSha256 !== sha256(JSON.stringify(staticManifest.configuration))
  )
    throw new Error('Invalid static manifest/configuration identity.');
  if (
    staticManifest.blog !== undefined &&
    (e.scope.kind !== 'site' ||
      identity(staticManifest.blog) !==
        identity({
          delivery: 'server',
          apiContract: 'articles-v1',
          sitemapPath: '/blog/sitemap.xml',
        }))
  )
    throw new Error('Invalid independent Blog delivery declaration.');
  checkEntries(staticManifest.entries);
  for (const entry of staticManifest.entries) {
    requireFile(entry.path, entry.sha256);
    if (files.get(entry.path).bytes !== entry.bytes)
      throw new Error('Static manifest byte count mismatch.');
  }
  if (!Array.isArray(e.functions)) throw new Error('Missing function descriptors.');
  const names = new Set();
  for (const f of e.functions) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(f.name) ||
      names.has(f.name) ||
      typeof f.runtime !== 'string' ||
      !f.runtime.trim() ||
      f.runtime.length > 128 ||
      !isHash(f.sha256)
    )
      throw new Error('Invalid or duplicate function descriptor.');
    names.add(f.name);
    requireFile(f.packagePath, f.sha256);
  }
  if (e.scope.kind === 'site') {
    if (!staticManifest.entries.some((entry) => entry.path === 'index.html'))
      throw new Error('Site artifact has no homepage.');
    requireFile(e.snapshotPath);
    readJson(directory, e.snapshotPath, limits.snapshotBytes);
  } else if (e.scope.kind === 'canary') {
    if (staticManifest.configurationSha256 !== policy.configurationSha256)
      throw new Error('Canary must retain the trusted hosting configuration.');
    const prefix = e.scope.prefix;
    if (typeof prefix !== 'string' || !prefix.endsWith('/'))
      throw new Error('Invalid canary scope prefix.');
    assertHostingPath(prefix.slice(0, -1));
    if (
      prefix.startsWith('products/') ||
      prefix.startsWith('__auth/') ||
      e.functions.length ||
      e.snapshotPath !== null
    )
      throw new Error('Canary cannot contain functions or public product snapshots.');
    if (
      !staticManifest.entries.some((entry) => entry.path === `${prefix}index.html`) ||
      staticManifest.entries.some(
        ({ path }) =>
          !path.startsWith(prefix) ||
          isSitemap(path) ||
          path.toLowerCase().endsWith('.xml') ||
          /(?:^|\/)(?:robots\.txt|seo-manifest\.json|manifest\.json|BingSiteAuth\.xml|google[a-z0-9]+\.html)$/.test(
            path,
          ),
      )
    )
      throw new Error('Static files escape canary scope.');
  } else throw new Error('Unknown release scope.');
  if (!isHash(e.compatibilityRef?.sha256)) throw new Error('Missing compatibility file hash.');
  requireFile(e.compatibilityRef?.path, e.compatibilityRef.sha256);
  readJson(directory, e.compatibilityRef.path);
  const declared = new Set([
    e.staticManifestPath,
    ...staticManifest.entries.map((entry) => entry.path),
    ...e.functions.map((f) => f.packagePath),
    e.compatibilityRef.path,
  ]);
  if (e.snapshotPath !== null) declared.add(e.snapshotPath);
  if (declared.size !== files.size || [...files.keys()].some((path) => !declared.has(path)))
    throw new Error('Undeclared payload member.');
  return freeze(structuredClone({ envelope: e, payload, staticManifest, mode }));
}
