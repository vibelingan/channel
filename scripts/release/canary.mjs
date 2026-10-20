import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyReleaseArtifact } from './artifact.mjs';
import { configurationHash, configurationStateHash } from './hosting-configuration.mjs';
import {
  assertHostingPath,
  assertOrigin,
  freeze,
  identity,
  isHash,
  readJson,
  readObject,
  sha256,
} from './input.mjs';

export function assertCanaryPolicy(policy) {
  assertOrigin(policy.siteOrigin);
  if (
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(policy.repository) ||
    !/^[A-Za-z0-9_-]+$/.test(policy.envId) ||
    policy.canaryPrefix !== '__release-canary/' ||
    policy.workflowPath !== '.github/workflows/seo-static-canary.yml' ||
    !/^refs\/heads\/[A-Za-z0-9_/-]+$/.test(policy.trustedRef)
  )
    throw new Error('Invalid pinned canary policy');
}

function canaryHtml(variant) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Release canary ${variant}</title></head><body><main data-release-canary="${variant}"><h1>Release canary ${variant}</h1><p>Static delivery verification.</p></main></body></html>\n`;
}

export function createCanaryPayload({
  directory,
  policy,
  configuration,
  variant,
  codeSha,
  now = Date.now(),
}) {
  assertCanaryPolicy(policy);
  if (!['A', 'B'].includes(variant)) throw new Error('Invalid canary variant');
  if (!/^[a-f0-9]{40}$/.test(codeSha)) throw new Error('Invalid code SHA');
  const path = `${policy.canaryPrefix}index.html`;
  const files = new Map([[path, canaryHtml(variant)]]);
  const entry = (path, body) => ({ path, bytes: Buffer.byteLength(body), sha256: sha256(body) });
  files.set(
    'static-manifest.json',
    JSON.stringify({
      schemaVersion: 2,
      purpose: 'static-release',
      configuration,
      configurationSha256: configurationHash(configuration),
      entries: [...files].map(([path, body]) => entry(path, body)),
    }),
  );
  const compatibility = JSON.stringify({
    schemaVersion: 1,
    purpose: 'static-canary',
    variant,
    configurationStateSha256: configurationStateHash(configuration),
  });
  files.set('compatibility.json', compatibility);
  const manifest = {
    schemaVersion: 2,
    purpose: 'release-payload',
    releaseId: `canary-${variant}-${codeSha}`,
    codeSha,
    target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
    scope: { kind: 'canary', prefix: policy.canaryPrefix },
    createdAt: new Date(now).toISOString(),
    staticManifestPath: 'static-manifest.json',
    snapshotPath: null,
    functions: [],
    compatibilityRef: { path: 'compatibility.json', sha256: sha256(compatibility) },
    entries: [...files].map(([path, body]) => entry(path, body)),
  };
  files.set('payload-manifest.json', JSON.stringify(manifest));
  for (const [path, body] of files) {
    assertHostingPath(path);
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), body, { flag: 'wx' });
  }
  return manifest;
}

export function canaryArtifact({ directory, policy, run, acceptedSeal, now = Date.now() }) {
  assertCanaryPolicy(policy);
  const payload = readJson(directory, 'payload-manifest.json');
  const configuration = readJson(directory, payload.staticManifestPath);
  const envelope = {
    ...payload,
    artifact: {
      repository: run.repository,
      workflowPath: run.workflowPath,
      runId: run.runId,
      artifactId: run.artifact.id,
      expiresAt: run.artifact.expiresAt,
      manifestSha256: sha256(JSON.stringify(payload)),
    },
  };
  const artifactPolicy = {
    repository: policy.repository,
    workflowPath: policy.workflowPath,
    event: 'workflow_dispatch',
    ref: policy.trustedRef,
    target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
    scope: { kind: 'canary', prefix: policy.canaryPrefix },
    configurationSha256: configuration.configurationSha256,
  };
  const input = { directory, envelope, policy: artifactPolicy, run, acceptedSeal, now };
  const verified = verifyReleaseArtifact({
    ...input,
    mode: acceptedSeal ? 'recovery' : 'candidate',
  });
  if (
    verified.staticManifest.entries.length !== 1 ||
    verified.staticManifest.entries[0].path !== `${policy.canaryPrefix}index.html`
  )
    throw new Error('D1 permits one canary HTML file only');
  const compatibility = readJson(directory, payload.compatibilityRef.path);
  if (compatibility.purpose !== 'static-canary' || !['A', 'B'].includes(compatibility.variant))
    throw new Error('Invalid canary compatibility');
  if (
    readObject(directory, `${policy.canaryPrefix}index.html`).toString('utf8') !==
    canaryHtml(compatibility.variant)
  )
    throw new Error('Canary HTML differs from the inert fixture');
  return freeze({ ...input, ...verified });
}

export function reviewCanaryPlan({ input, request, status, now = Date.now(), reviewedAt = now }) {
  if (
    !['initialize', 'publish', 'restore'].includes(request.action) ||
    !/^[a-f0-9]{40}$/.test(request.executorSha) ||
    typeof request.reason !== 'string' ||
    !request.reason.trim() ||
    request.reason.length > 300
  )
    throw new Error('Invalid manual request');
  const active = status.scope.active?.activationId ?? 'none';
  if (
    active !== request.expectedActivationId ||
    (request.action === 'initialize') !== (active === 'none')
  )
    throw new Error('Expected activation mismatch');
  if (!Number.isSafeInteger(reviewedAt) || reviewedAt > now || now - reviewedAt > 1_800_000)
    throw new Error('Review plan expired');
  const body = {
    schemaVersion: 1,
    target: input.envelope.target,
    scope: input.envelope.scope,
    targetId: status.targetId,
    scopeVersion: status.scope.version,
    active,
    action: request.action,
    restoreRunId: request.restoreRunId ?? null,
    reason: request.reason,
    executorSha: request.executorSha,
    artifact: input.envelope.artifact,
    configurationStateSha256: configurationStateHash(input.staticManifest.configuration),
    reviewedAt,
    expiresAt: reviewedAt + 1_800_000,
  };
  const hash = identity(body);
  return freeze({
    ...body,
    sha256: hash,
    token: `${hash}:${reviewedAt}`,
    uploads: input.staticManifest.entries,
    deletes: [],
    configurationChanges: [],
    functions: [],
    businessDataWrites: [],
  });
}

export function verifyPlanToken({ token, ...args }) {
  const [hash, stamp, extra] = String(token).split(':');
  if (!isHash(hash) || extra !== undefined || !/^[0-9]{13}$/.test(stamp))
    throw new Error('Invalid reviewed plan token');
  const plan = reviewCanaryPlan({ ...args, reviewedAt: Number(stamp) });
  if (hash !== plan.sha256) throw new Error('Reviewed plan changed');
  return plan;
}
