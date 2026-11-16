import { assertCatalogRuntimeProof } from './catalog-runtime-recovery.mjs';
import { mergeFunctionEnvironment } from './function-config.mjs';
import { functionConfiguration } from './function-provider.mjs';
import { assertOrigin, identity, isHash } from './input.mjs';
import { assertCleanAcceptedSite } from './site-policy.mjs';

const writers = ['admin', 'alibaba-catalog-sync'];
const names = [...writers, 'public-api'];
const collection = 'catalogSeoBuilders';
const purpose = 'catalog-writer-recovery-preparation';
const ownedKeys = (name) => [
  'CATALOG_SEO_SITE_ORIGIN',
  'CATALOG_DETAIL_APPROVAL_ENABLED',
  name === 'public-api' ? 'CATALOG_SEO_PAGE_READINESS' : 'CATALOG_SEO_RECORDING',
];

export function assertCatalogRecoveryInvocation(env, policy) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== policy.repository ||
    env.GITHUB_REF !== policy.trustedRef ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_WORKFLOW_REF !==
      `${policy.repository}/${policy.workflowPath}@${policy.trustedRef}` ||
    env.TCB_ENV_ID !== policy.envId ||
    !['resume', 'resume-readiness'].includes(env.CATALOG_RUNTIME_ACTION) ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
    (env.CATALOG_RUNTIME_SHA && env.CATALOG_RUNTIME_SHA !== env.GITHUB_SHA)
  )
    throw Error('Untrusted catalog recovery invocation');
  return { executorSha: env.GITHUB_SHA, sourceRunId: env.GITHUB_RUN_ID };
}

/** Only control records are writable; every replacement compares its last observed value. */
export function createCatalogRecoveryRecords(store, executorSha) {
  if (!/^[a-f0-9]{40}$/.test(executorSha ?? '')) throw Error('Exact recovery executor required');
  const preparationKey = `runtime-recovery-preparation-${executorSha}`;
  const canonical = (row) => {
    if (row === null) return null;
    const { _id, ...body } = row;
    return body;
  };
  const read = async (key) => canonical(await store.get(collection, key));
  const immutable = async (key, value) => {
    try {
      await store.transaction(async (tx) => {
        const existing = canonical(await tx.get(collection, key));
        if (existing && identity(existing) !== identity(value))
          throw Error('Recovery history differs; no overwrite allowed');
        if (!existing) await tx.set(collection, { _id: key, ...value });
      });
    } catch {
      const actual = await read(key);
      if (!actual || identity(actual) !== identity(value))
        throw Error('Recovery history write remains unconfirmed; do not repeat it');
    }
  };
  let lastObserved;
  return {
    getPreparation: () => read(preparationKey),
    putPreparation: (value) => immutable(preparationKey, value),
    registry: {
      async get() {
        const row = await read('runtime-activation');
        lastObserved = row === null ? null : identity(row);
        return row;
      },
      async set(value) {
        if (lastObserved === undefined) throw Error('Observe activation before replacing it');
        const expected = lastObserved;
        await store.transaction(async (tx) => {
          const row = canonical(await tx.get(collection, 'runtime-activation'));
          if ((row === null ? null : identity(row)) !== expected)
            throw Error('Catalog activation changed before commit');
          await tx.set(collection, { _id: 'runtime-activation', ...value });
        });
      },
      getHistory: (hash) => {
        if (!isHash(hash)) throw Error('Exact historical activation required');
        return read(`runtime-activation-history-${hash}`);
      },
      putHistory: (hash, row) => {
        if (!isHash(hash) || identity(row) !== hash) throw Error('Historical activation differs');
        return immutable(`runtime-activation-history-${hash}`, row);
      },
    },
  };
}

/** Re-enable recording without replacing any function code, customer content, or unrelated setting. */
export async function resumeCatalogWriters({
  target,
  executorSha,
  sourceRunId,
  beforeAcceptedSite,
  records,
  readFunctions,
  assertClockStopped,
  assertWebsiteUnchanged,
  requireAncestor,
  fingerprint,
  setFlags,
  settle,
  report = (_event) => {},
}) {
  assertOrigin(target.siteOrigin);
  await assertClockStopped();
  await assertWebsiteUnchanged();
  const initial = await readFunctions();
  validateFunctions(initial, target);
  for (const name of names)
    await requireAncestor({
      beforeVersion: initial[name].health.releaseId,
      sourceSha: executorSha,
    });
  let preparation = await records.getPreparation();
  if (!preparation) {
    const activation = await records.registry.get();
    assertSafeActivation(activation, target.siteOrigin);
    preparation = {
      schemaVersion: 1,
      purpose,
      siteOrigin: target.siteOrigin,
      executorSha,
      sourceRunId,
      previousActivationHash: identity(activation),
      previousActivation: activation,
      beforeAcceptedSite,
      functions: names.map((name) => snapshot(initial[name], name, fingerprint)),
    };
    await records.putPreparation(preparation);
    if (identity(await records.getPreparation()) !== identity(preparation))
      throw Error('Recovery preparation requires exact readback');
  }
  validatePreparation(preparation, { target, executorSha });
  assertObserved(initial, preparation, fingerprint);
  const currentActivation = await records.registry.get();
  const continuing =
    currentActivation?.schemaVersion === 2 &&
    currentActivation.previousActivationHash === preparation.previousActivationHash &&
    currentActivation.executorSha === executorSha;
  if (!continuing && identity(currentActivation) !== preparation.previousActivationHash)
    throw Error('The selected recovery activation changed before any function update');
  if (
    continuing &&
    writers.some(
      (name) =>
        variables(initial[name].detail).CATALOG_SEO_RECORDING !== '1' ||
        initial[name].health.catalogSeoRecording !== true,
    )
  )
    throw Error('Writer recording stopped after recovery began; a new recovery epoch is required');
  for (const name of writers) {
    await assertClockStopped();
    await assertWebsiteUnchanged();
    const result = await setFlags({ name, phase: 'record', before: initial[name].detail });
    report({ stage: 'writer-recording', name, changed: result.changed === true });
  }
  const read = async () => {
    await assertClockStopped();
    const current = await readFunctions();
    validateFunctions(current, target);
    assertObserved(current, preparation, fingerprint);
    for (const name of writers)
      if (
        !current[name].health.catalogSeoRecording ||
        variables(current[name].detail).CATALOG_SEO_RECORDING !== '1'
      )
        throw Error('Running writer has not confirmed recording');
    return {
      configurationHash: identity(
        writers.map((name) => ({
          name,
          configuration: fingerprint(functionConfiguration(current[name].detail)),
          releaseId: current[name].health.releaseId,
          codeBytes: current[name].detail.CodeSize,
        })),
      ),
      maximumTimeoutSeconds: Math.max(...writers.map((name) => current[name].detail.Timeout)),
      writerVersions: writers.map((name) => ({ name, releaseId: current[name].health.releaseId })),
    };
  };
  const proof = await settle({
    registry: records.registry,
    siteOrigin: target.siteOrigin,
    executorSha,
    sourceRunId,
    previousActivationHash: preparation.previousActivationHash,
    read,
    report,
  });
  await assertClockStopped();
  await assertWebsiteUnchanged();
  return {
    phase: 'resume',
    executorSha,
    proof,
    previousActivationHash: preparation.previousActivationHash,
    websiteWrites: 0,
    businessWrites: 0,
    functionCodeWrites: 0,
  };
}

/** Readiness follows accepted current-content HTML; this separate phase changes only public-api. */
export async function enableRecoveredCatalogReadiness({
  target,
  executorSha,
  records,
  readFunctions,
  assertClockStopped,
  assertWebsiteUnchanged,
  requireAncestor,
  fingerprint,
  setFlags,
  assertAcceptedProgram,
  assertRecoveryProof,
}) {
  await assertClockStopped();
  await assertWebsiteUnchanged();
  const preparation = await records.getPreparation();
  validatePreparation(preparation, { target, executorSha });
  const proof = await records.registry.get();
  assertRecoveryProof(proof, target.siteOrigin);
  if (
    proof.schemaVersion !== 2 ||
    proof.executorSha !== executorSha ||
    proof.previousActivationHash !== preparation.previousActivationHash
  )
    throw Error('Exact completed writer recovery required before page readiness');
  const initial = await readFunctions();
  validateFunctions(initial, target);
  assertObserved(initial, preparation, fingerprint);
  for (const writer of proof.writerVersions)
    if (
      initial[writer.name].health.releaseId !== writer.releaseId ||
      !initial[writer.name].health.catalogSeoRecording ||
      variables(initial[writer.name].detail).CATALOG_SEO_RECORDING !== '1'
    )
      throw Error('Recovered writer source or recording changed');
  await requireAncestor({
    beforeVersion: initial['public-api'].health.releaseId,
    sourceSha: executorSha,
  });
  await assertAcceptedProgram({ preparation, proof });
  const result = await setFlags({
    name: 'public-api',
    phase: 'readiness',
    before: initial['public-api'].detail,
  });
  const after = await readFunctions();
  validateFunctions(after, target);
  assertObserved(after, preparation, fingerprint);
  for (const name of writers)
    if (
      fingerprint(functionConfiguration(after[name].detail)) !==
      fingerprint(functionConfiguration(initial[name].detail))
    )
      throw Error('Another writer setting changed during readiness');
  if (
    !after['public-api'].health.catalogSeoPageReadiness ||
    variables(after['public-api'].detail).CATALOG_SEO_PAGE_READINESS !== '1'
  )
    throw Error('Running public API has not confirmed page readiness');
  await assertAcceptedProgram({ preparation, proof });
  await assertClockStopped();
  await assertWebsiteUnchanged();
  return {
    phase: 'resume-readiness',
    executorSha,
    changed: result.changed === true,
    websiteWrites: 0,
    businessWrites: 0,
    functionCodeWrites: 0,
  };
}

function variables(detail) {
  const entries = detail?.Environment?.Variables;
  if (
    !Array.isArray(entries) ||
    entries.some((v) => typeof v.Key !== 'string' || typeof v.Value !== 'string') ||
    new Set(entries.map((v) => v.Key)).size !== entries.length
  )
    throw Error('Complete unmasked function settings required');
  return mergeFunctionEnvironment({
    current: {
      status: 'complete',
      variables: Object.fromEntries(entries.map((v) => [v.Key, v.Value])),
    },
    managedKeys: [],
    desired: {},
  });
}
function validateFunctions(observed, target) {
  if (!observed || identity(Object.keys(observed).sort()) !== identity([...names].sort()))
    throw Error('All three exact function observations required');
  for (const name of names) {
    const { detail, health } = observed[name];
    const env = variables(detail);
    if (
      detail.FunctionName !== name ||
      detail.Namespace !== target.envId ||
      detail.Runtime !== 'Nodejs20.19' ||
      detail.Type !== 'Event' ||
      detail.Handler !== 'index.main' ||
      detail.Status !== 'Active' ||
      detail.AvailableStatus !== 'Available' ||
      !Number.isSafeInteger(detail.CodeSize) ||
      detail.CodeSize < 1 ||
      !Number.isSafeInteger(detail.Timeout) ||
      detail.Timeout < 1 ||
      detail.Timeout > 900 ||
      !/^[a-f0-9]{40}$/.test(health.releaseId ?? '') ||
      env.TCB_ENV !== target.envId ||
      env.CATALOG_DETAIL_APPROVAL_ENABLED !== '1' ||
      env.CATALOG_SEO_SITE_ORIGIN !== target.siteOrigin ||
      !['0', '1'].includes(
        env[name === 'public-api' ? 'CATALOG_SEO_PAGE_READINESS' : 'CATALOG_SEO_RECORDING'],
      )
    )
      throw Error('Managed function source, scope or settings are not ready');
  }
}
function snapshot(observed, name, fingerprint) {
  const config = functionConfiguration(observed.detail);
  const env = variables(observed.detail);
  return {
    name,
    releaseId: observed.health.releaseId,
    codeBytes: observed.detail.CodeSize,
    configurationHash: fingerprint(config),
    outsideHash: fingerprint(withoutOwned(config, name)),
    previousFlags: Object.fromEntries(ownedKeys(name).map((key) => [key, env[key]])),
  };
}
function withoutOwned(config, name) {
  const keys = ownedKeys(name);
  return {
    ...config,
    Environment: {
      Variables: config.Environment.Variables.filter((v) => !keys.includes(v.Key)).sort((a, b) =>
        a.Key.localeCompare(b.Key),
      ),
    },
  };
}
function validatePreparation(preparation, { target, executorSha }) {
  if (
    !preparation ||
    preparation.schemaVersion !== 1 ||
    preparation.purpose !== purpose ||
    preparation.siteOrigin !== target.siteOrigin ||
    preparation.executorSha !== executorSha ||
    !/^[1-9][0-9]*$/.test(preparation.sourceRunId ?? '') ||
    !isHash(preparation.previousActivationHash) ||
    identity(preparation.previousActivation) !== preparation.previousActivationHash ||
    !Array.isArray(preparation.functions) ||
    identity(preparation.functions.map((x) => x.name)) !== identity(names)
  )
    throw Error('Exact immutable recovery preparation required');
  assertSitePointer(preparation.beforeAcceptedSite);
  assertSafeActivation(preparation.previousActivation, target.siteOrigin);
  for (const entry of preparation.functions)
    if (
      !/^[a-f0-9]{40}$/.test(entry.releaseId ?? '') ||
      !isHash(entry.configurationHash) ||
      !isHash(entry.outsideHash) ||
      !Number.isSafeInteger(entry.codeBytes) ||
      entry.codeBytes < 1 ||
      identity(Object.keys(entry.previousFlags ?? {}).sort()) !==
        identity(ownedKeys(entry.name).sort()) ||
      entry.previousFlags.CATALOG_SEO_SITE_ORIGIN !== target.siteOrigin ||
      entry.previousFlags.CATALOG_DETAIL_APPROVAL_ENABLED !== '1' ||
      !['0', '1'].includes(
        entry.previousFlags[
          entry.name === 'public-api' ? 'CATALOG_SEO_PAGE_READINESS' : 'CATALOG_SEO_RECORDING'
        ],
      )
    )
      throw Error('Incomplete recovery source or configuration proof');
}

/** Require a new accepted current-program site after this recovery, not an old matching pointer. */
export function assertRecoveredCatalogSite({
  beforeAcceptedSite,
  status,
  run,
  active,
  approved,
  proof,
  executorSha,
  target,
}) {
  assertSitePointer(beforeAcceptedSite);
  const current = assertCleanAcceptedSite(status);
  assertSitePointer(current);
  const part = run?.composition?.static;
  const accepted = run?.accepted;
  const seal = accepted?.seals?.static;
  if (
    current.sourceRunId === beforeAcceptedSite.sourceRunId ||
    current.activationId === beforeAcceptedSite.activationId ||
    run?.state !== 'SUCCEEDED' ||
    run.scopeKey !== 'site' ||
    run.targetId !== status.targetId ||
    run.runId !== current.sourceRunId ||
    !Number.isSafeInteger(run.createdAt) ||
    run.createdAt < proof.acceptedAt ||
    !Number.isSafeInteger(accepted?.acceptedAt) ||
    accepted.acceptedAt < run.createdAt ||
    !Number.isSafeInteger(run.completedAt) ||
    run.completedAt < accepted.acceptedAt ||
    accepted.sourceRunId !== current.sourceRunId ||
    accepted.activationId !== current.activationId ||
    accepted.compositionHash !== current.compositionHash ||
    run.compositionHash !== current.compositionHash ||
    identity(run.composition) !== current.compositionHash ||
    part?.codeSha !== executorSha ||
    !isHash(part.contentSha256) ||
    part.releaseId !== run.runId ||
    seal?.activationId !== current.activationId ||
    seal.releaseId !== part.releaseId ||
    seal.codeSha !== part.codeSha ||
    identity(seal.artifact) !== identity(part.artifact) ||
    seal.target?.envId !== target.envId ||
    seal.target?.siteOrigin !== target.siteOrigin ||
    active?.acceptedRunId !== current.sourceRunId ||
    active.catalogTracked !== true ||
    active.codeSha !== executorSha ||
    active.executorSha !== executorSha ||
    active.executorRef !== 'feat/seo-foundation' ||
    !isHash(active.manifestSha256) ||
    approved?.schemaVersion !== 1 ||
    approved.inputSchema !== 1 ||
    approved.codeSha !== executorSha ||
    approved.manifestSha256 !== active.manifestSha256
  )
    throw Error(
      'Accept a new current-program tracked website after writer recovery before readiness',
    );
  return current;
}

function assertSitePointer(value) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'activationId,compositionHash,sourceRunId' ||
    !/^[A-Za-z0-9:_-]{1,200}$/.test(value.activationId ?? '') ||
    !/^site-[1-9][0-9]*-[1-9][0-9]*$/.test(value.sourceRunId ?? '') ||
    !isHash(value.compositionHash)
  )
    throw Error('Exact accepted website identity required');
}
function assertObserved(current, preparation, fingerprint) {
  for (const saved of preparation.functions) {
    const observed = current[saved.name];
    if (
      observed.health.releaseId !== saved.releaseId ||
      observed.detail.CodeSize !== saved.codeBytes ||
      fingerprint(withoutOwned(functionConfiguration(observed.detail), saved.name)) !==
        saved.outsideHash
    )
      throw Error('Function code or unrelated configuration changed after preparation');
    const env = variables(observed.detail);
    for (const key of ownedKeys(saved.name))
      if (
        env[key] !== saved.previousFlags[key] &&
        !(key.endsWith('_RECORDING') || key.endsWith('_READINESS'))
      )
        throw Error('Prepared catalog site or detail mode changed');
  }
}

function assertSafeActivation(row, siteOrigin) {
  assertCatalogRuntimeProof(row, siteOrigin);
  if (
    row.schemaVersion === 1 &&
    identity(Object.keys(row).sort()) !==
      identity(
        [
          'schemaVersion',
          'purpose',
          'siteOrigin',
          'codeSha',
          'sourceRunId',
          'configurationHash',
          'maximumTimeoutSeconds',
          'observedAt',
          'usableAfter',
          'accepted',
          'acceptedAt',
        ].sort(),
      )
  )
    throw Error('Previous activation includes unreviewed fields; do not archive it');
}
