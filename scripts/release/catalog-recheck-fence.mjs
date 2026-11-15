import { assertInitialCatalogRuntime } from './catalog-runtime-activation.mjs';
import { functionConfiguration } from './function-provider.mjs';
import { freeze, identity, isHash } from './input.mjs';
import { assertScope, assertTarget, normalizePolicy, tables } from './ledger.mjs';
import { assertCleanAcceptedSite } from './site-policy.mjs';

export function catalogRecheckInventoryFetch({ request, budget }) {
  return async (url, options) => {
    if (++budget.publicListReads > Math.ceil(50_000 / 48) + 1)
      throw Error('Public inventory exceeds the bounded recheck read budget');
    const response = await request('GET', String(url), {
      ...options,
      timeoutMs: 20_000,
      maxBytes: 2 * 1024 * 1024,
    });
    const body = JSON.parse(response.body.toString());
    if (
      response.status !== 200 ||
      body.ok !== true ||
      !Number.isSafeInteger(body.data?.total) ||
      body.data.total < 0 ||
      body.data.total > 50_000
    )
      throw Error('Public inventory exceeds the bounded recheck product budget');
    return new Response(new Uint8Array(response.body), {
      status: response.status,
      headers: response.headers,
    });
  };
}

/** Capture the real publication records; every queue transaction re-reads both before writing. */
export function createCatalogRecheckFence({ policy, targetRow, scopeRow, expectedAcceptedRunId }) {
  const config = normalizePolicy(policy);
  const targetKey = config.targetId;
  const scopeKey = `${targetKey}-site`;
  const validate = (target, scope) => {
    if (target?._id !== targetKey || scope?._id !== scopeKey)
      throw Error('Exact publication record identifiers required');
    assertTarget(target, config);
    assertScope(scope, config, 'site');
    if (
      target.lease !== null ||
      target.currentRunId !== null ||
      target.dirtyRunId !== null ||
      target.unresolvedOperation !== null ||
      scope.baseline?.sourceRunId !== expectedAcceptedRunId ||
      identity(scope.active) !== identity(scope.baseline)
    )
      throw Error('Publication must remain idle at the selected accepted website');
  };
  validate(targetRow, scopeRow);
  const targetHash = identity(targetRow);
  const scopeHash = identity(scopeRow);
  const assertUnchanged = (target, scope) => {
    validate(target, scope);
    if (identity(target) !== targetHash || identity(scope) !== scopeHash)
      throw Error('Publication records changed; stop queuing further requests');
  };
  return Object.freeze({
    targetKey,
    scopeKey,
    receipt: freeze({
      targetId: targetKey,
      targetVersion: targetRow.version,
      targetHash,
      scopeVersion: scopeRow.version,
      scopeHash,
      expectedAcceptedRunId,
    }),
    assertUnchanged,
    async assertCanQueue(tx) {
      const target = await tx.get(tables.targets, targetKey);
      const scope = await tx.get(tables.scopes, scopeKey);
      assertUnchanged(target, scope);
    },
  });
}

/** The queue repair is allowed only for the explicitly selected, successfully accepted program. */
export function assertCatalogRecheckSite({
  status,
  run,
  active,
  proof,
  expectedAcceptedRunId,
  expectedExecutorSha,
  policy,
}) {
  const baseline = assertCleanAcceptedSite(status);
  assertInitialCatalogRuntime(proof, policy.siteOrigin);
  if (
    proof.schemaVersion !== 2 ||
    proof.executorSha !== expectedExecutorSha ||
    baseline.sourceRunId !== expectedAcceptedRunId ||
    run?.runId !== expectedAcceptedRunId ||
    run.state !== 'SUCCEEDED' ||
    run.scopeKey !== 'site' ||
    run.targetId !== status.targetId ||
    run.accepted?.sourceRunId !== expectedAcceptedRunId ||
    run.accepted.activationId !== baseline.activationId ||
    run.accepted.compositionHash !== baseline.compositionHash ||
    run.compositionHash !== baseline.compositionHash ||
    identity(run.composition) !== baseline.compositionHash ||
    run.composition?.static?.codeSha !== expectedExecutorSha ||
    !Number.isSafeInteger(run.accepted.acceptedAt) ||
    run.accepted.acceptedAt < proof.acceptedAt ||
    active?.acceptedRunId !== expectedAcceptedRunId ||
    active.codeSha !== expectedExecutorSha ||
    active.executorSha !== expectedExecutorSha ||
    active.executorRef !== 'feat/seo-foundation' ||
    !isHash(active.manifestSha256) ||
    active.catalogTracked !== true
  )
    throw Error('Explicit accepted current program and writer recovery required before recheck');
  return baseline;
}

/** Read-only runtime checks; secret-bearing details are returned only to the local caller. */
export function assertCatalogRecheckRuntime({ writers, clock, proof, policy }) {
  const expected = ['admin', 'alibaba-catalog-sync'];
  if (!Array.isArray(writers) || identity(writers.map((item) => item.name)) !== identity(expected))
    throw Error('Both running writer observations required');
  const value = (detail, key) => {
    const values = detail.Environment?.Variables?.filter((item) => item.Key === key);
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0].Value !== 'string')
      throw Error('Exact runtime flag required');
    return values[0].Value;
  };
  const ready = (detail, name) => {
    if (
      detail.FunctionName !== name ||
      detail.Namespace !== policy.envId ||
      detail.Status !== 'Active' ||
      detail.AvailableStatus !== 'Available' ||
      detail.Runtime !== 'Nodejs20.19' ||
      detail.Type !== 'Event' ||
      detail.Handler !== 'index.main'
    )
      throw Error('Managed runtime scope or status differs');
  };
  for (const [index, item] of writers.entries()) {
    ready(item.detail, item.name);
    if (
      proof.writerVersions[index]?.name !== item.name ||
      proof.writerVersions[index]?.releaseId !== item.health.releaseId ||
      item.health.catalogSeoRecording !== true ||
      value(item.detail, 'CATALOG_SEO_RECORDING') !== '1' ||
      value(item.detail, 'CATALOG_DETAIL_APPROVAL_ENABLED') !== '1' ||
      value(item.detail, 'CATALOG_SEO_SITE_ORIGIN') !== policy.siteOrigin ||
      value(item.detail, 'TCB_ENV') !== policy.envId
    )
      throw Error('Running writer recording or accepted source differs');
  }
  ready(clock, 'catalog-seo-clock');
  if (
    clock.Description !== 'channel-catalog-seo-clock-v1' ||
    value(clock, 'CATALOG_SEO_CLOCK_ENABLED') !== '0'
  )
    throw Error('The owned automatic update clock must remain disabled');
  const configuration = (detail) => {
    const value = functionConfiguration(structuredClone(detail));
    value.Environment?.Variables?.sort((a, b) => a.Key.localeCompare(b.Key));
    return value;
  };
  return [
    ...writers.map(({ name, detail, health }) => ({
      name,
      configuration: configuration(detail),
      codeBytes: detail.CodeSize,
      releaseId: health.releaseId,
    })),
    {
      name: 'catalog-seo-clock',
      configuration: configuration(clock),
      codeBytes: clock.CodeSize,
    },
  ];
}
