import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyReleaseArtifact } from './artifact.mjs';
import { configurationHash } from './hosting-configuration.mjs';
import { assertHostingPath, checkEntries, limits, readJson, sha256 } from './input.mjs';
import { siteProducerPolicy } from './site-producers.mjs';
const metadataPaths = new Set([
  'static-manifest.json',
  'product-snapshot.json',
  'compatibility.json',
  'payload-manifest.json',
]);
export function createSitePayload({
  directory,
  policy,
  configuration,
  codeSha,
  releaseId,
  files,
  snapshot,
  blogDelivery = 'static',
  renderer = /** @type {null | {codeSha:string,manifestSha256:string,archiveSha256:string,releaseId:number,inputSchema:number}} */ (
    null
  ),
  objectProofs = /** @type {{path:string,bytes:number,sha256:string,etag:string,lastModified:string}[]} */ ([]),
  now = Date.now(),
}) {
  if (
    !['static', 'server'].includes(blogDelivery) ||
    !(files instanceof Map) ||
    !files.size ||
    files.size > limits.files ||
    !/^[a-f0-9]{40}$/.test(codeSha) ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(releaseId) ||
    snapshot?.siteOrigin !== policy.siteOrigin ||
    !files.has('index.html')
  )
    throw new Error('Complete site files, fixed identity and public snapshot required');
  const data = new Map();
  for (const [path, body] of files) {
    assertHostingPath(path);
    if (
      metadataPaths.has(path) ||
      path === '404.html' ||
      /^(?:__|\.cloudbase-backup\/|google[a-z0-9]+\.html$|BingSiteAuth\.xml$)/.test(path)
    )
      throw new Error('Reserved or unmanaged site payload member');
    data.set(path, Buffer.from(body));
  }
  const entry = ([path, body]) => ({ path, bytes: body.length, sha256: sha256(body) });
  const entries = [...data].map(entry).map((value) => {
    const proof = objectProofs.find(
      (p) => p.path === value.path && p.bytes === value.bytes && p.sha256 === value.sha256,
    );
    if (!proof) return value;
    if (
      typeof proof.etag !== 'string' ||
      !proof.etag ||
      typeof proof.lastModified !== 'string' ||
      !proof.lastModified
    )
      throw Error('Incomplete verified object version');
    return { ...value, objectVersion: { etag: proof.etag, lastModified: proof.lastModified } };
  });
  checkEntries(entries);
  const manifest = {
    schemaVersion: 2,
    purpose: 'static-release',
    configuration,
    configurationSha256: configurationHash(configuration),
    entries,
    ...(blogDelivery === 'server'
      ? {
          blog: {
            delivery: 'server',
            apiContract: 'articles-v1',
            sitemapPath: '/blog/sitemap.xml',
          },
        }
      : {}),
  };
  data.set('static-manifest.json', Buffer.from(JSON.stringify(manifest)));
  data.set('product-snapshot.json', Buffer.from(JSON.stringify(snapshot)));
  if (
    renderer &&
    (!/^[a-f0-9]{40}$/.test(renderer.codeSha) ||
      !/^[a-f0-9]{64}$/.test(renderer.manifestSha256) ||
      !/^[a-f0-9]{64}$/.test(renderer.archiveSha256) ||
      !Number.isSafeInteger(renderer.releaseId) ||
      renderer.releaseId < 1 ||
      renderer.inputSchema !== 1)
  )
    throw Error('Invalid archived renderer identity');
  const compatibility = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      purpose: 'static-site-only',
      codeSha,
      functions: 'unchanged',
      database: 'unchanged',
      ...(renderer ? { renderer } : {}),
    }),
  );
  data.set('compatibility.json', compatibility);
  const payload = {
    schemaVersion: 2,
    purpose: 'release-payload',
    releaseId,
    codeSha,
    target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
    scope: { kind: 'site' },
    createdAt: new Date(now).toISOString(),
    staticManifestPath: 'static-manifest.json',
    snapshotPath: 'product-snapshot.json',
    functions: [],
    compatibilityRef: { path: 'compatibility.json', sha256: sha256(compatibility) },
    entries: [...data].map(entry),
  };
  data.set('payload-manifest.json', Buffer.from(JSON.stringify(payload)));
  mkdirSync(directory, { recursive: false });
  for (const [path, body] of data) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), body, { flag: 'wx', mode: 0o600 });
  }
  return payload;
}
export function siteArtifact({
  directory,
  policy,
  run,
  acceptedSeal = /** @type {unknown} */ (null),
  now = Date.now(),
}) {
  if (!['push', 'workflow_dispatch'].includes(run.event))
    throw new Error('Untrusted site release event');
  const producer = siteProducerPolicy(policy, run);
  const payload = readJson(directory, 'payload-manifest.json');
  const envelope = {
    ...payload,
    artifact: {
      repository: run.repository,
      workflowPath: run.workflowPath,
      runId: run.runId,
      artifactId: run.artifact.id,
      expiresAt: run.artifact.expiresAt,
      manifestSha256: sha256(readFileSync(join(directory, 'payload-manifest.json'))),
    },
  };
  const artifactPolicy = {
    repository: policy.repository,
    workflowPath: producer.workflowPath,
    event: run.event,
    ref: producer.trustedRef,
    target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
    scope: { kind: 'site' },
  };
  const input = {
    envelope,
    directory,
    policy: artifactPolicy,
    run,
    acceptedSeal,
    mode: acceptedSeal ? 'recovery' : 'candidate',
    now,
  };
  const verified = verifyReleaseArtifact(input);
  return { ...verified, ...input };
}
