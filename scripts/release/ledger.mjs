import { assertHostingPath, assertOrigin, identity, isHash } from './input.mjs';

export const tables = Object.freeze({
  targets: 'siteReleaseTargets',
  scopes: 'siteReleaseScopes',
  runs: 'siteReleaseRuns',
  steps: 'siteReleaseSteps',
});
export function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}
export function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(value)) fail('INVALID_ID');
  return value;
}
export function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) fail('INVALID_TEXT');
  return value;
}
export function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('CORRUPT_COUNTER');
  return value;
}
export function bump(value) {
  const next = integer(value) + 1;
  return integer(next);
}
export function jsonCopy(value) {
  const body = JSON.stringify(value);
  if (typeof body !== 'string' || Buffer.byteLength(body) > 128 * 1024) fail('LEDGER_SIZE_LIMIT');
  return JSON.parse(body);
}
export function normalizePolicy(input) {
  const repository = text(input.repository).toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) fail('INVALID_REPOSITORY');
  const target = { repository, envId: id(input.envId), siteOrigin: assertOrigin(input.siteOrigin) };
  const scopes = { site: { kind: 'site' } };
  if (input.canaryPrefix !== undefined) {
    const prefix = input.canaryPrefix;
    if (
      typeof prefix !== 'string' ||
      !prefix.endsWith('/') ||
      prefix.startsWith('products/') ||
      prefix.startsWith('__auth/')
    )
      fail('INVALID_SCOPE');
    assertHostingPath(prefix.slice(0, -1));
    scopes.canary = { kind: 'canary', prefix };
  }
  return { target, scopes, targetId: identity(target), policyHash: identity({ target, scopes }) };
}
export function assertTarget(value, config) {
  if (
    value?.schemaVersion !== 1 ||
    value.targetId !== config.targetId ||
    value.policyHash !== config.policyHash ||
    identity(value.target) !== identity(config.target)
  )
    fail('TARGET_POLICY_MISMATCH');
  integer(value.version);
  integer(value.nextFence);
  if (value.lease !== null) {
    id(value.lease.ownerRunId);
    text(value.lease.runnerRef);
    integer(value.lease.fence);
    integer(value.lease.expiresAt);
    integer(value.lease.acquiredVersion);
    if (
      !value.lease.fence ||
      value.lease.fence > value.nextFence ||
      value.lease.acquiredVersion > value.version
    )
      fail('CORRUPT_LEASE');
  }
  for (const field of ['currentRunId', 'dirtyRunId']) if (value[field] !== null) id(value[field]);
  if (value.unresolvedOperation !== null) {
    id(value.unresolvedOperation.runId);
    id(value.unresolvedOperation.stepId);
    id(value.unresolvedOperation.operationId);
  }
}
export function assertScope(value, config, scopeKey) {
  if (
    value?.schemaVersion !== 1 ||
    value.targetId !== config.targetId ||
    value.scopeKey !== scopeKey ||
    identity(value.scope) !== identity(config.scopes[scopeKey])
  )
    fail('CORRUPT_SCOPE');
  integer(value.version);
  if ((value.active === null) !== (value.baseline === null)) fail('CORRUPT_BASELINE');
  if (
    value.active !== null &&
    (value.active.activationId !== value.baseline.activationId ||
      value.active.sourceRunId !== value.baseline.sourceRunId ||
      value.active.compositionHash !== value.baseline.compositionHash)
  )
    fail('CORRUPT_BASELINE');
}
export function validateComposition(composition, config, scopeKey, now, partial = false) {
  if (!composition || typeof composition !== 'object' || Array.isArray(composition))
    fail('INVALID_COMPOSITION');
  const keys = Object.keys(composition);
  if (
    (!partial && !keys.includes('static')) ||
    !keys.length ||
    keys.length > 33 ||
    keys.some((key) => key !== 'static' && !/^function:[A-Za-z0-9_-]{1,100}$/.test(key)) ||
    (scopeKey === 'canary' && keys.length !== 1)
  )
    fail('INVALID_COMPOSITION');
  for (const part of Object.values(composition)) {
    id(part.releaseId);
    if (
      !/^[a-f0-9]{40}$/.test(part.codeSha) ||
      !isHash(part.contentSha256) ||
      part.artifact?.repository !== config.target.repository ||
      !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(part.artifact.workflowPath) ||
      !/^[1-9][0-9]*$/.test(part.artifact.runId) ||
      !/^[1-9][0-9]*$/.test(part.artifact.artifactId) ||
      !isHash(part.artifact.manifestSha256)
    )
      fail('INVALID_ARTIFACT_REF');
    const expires = Date.parse(part.artifact.expiresAt);
    if (!Number.isFinite(expires) || (now !== null && expires <= now)) fail('ARTIFACT_EXPIRED');
  }
  return jsonCopy(composition);
}
