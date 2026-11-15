import { setTimeout as pause } from 'node:timers/promises';
import { assertOrigin, identity, isHash } from './input.mjs';

const purpose = 'catalog-writer-recovery';
const writers = ['admin', 'alibaba-catalog-sync'];
const source = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const run = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const boundedTimeout = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 900;

/** A new writer drain follows an explicit old proof; it cannot reuse that proof's elapsed time. */
export async function settleCatalogRuntimeRecovery({
  registry,
  siteOrigin,
  executorSha,
  sourceRunId,
  previousActivationHash,
  read,
  now = Date.now,
  wait = pause,
  report = (_event) => {},
}) {
  assertOrigin(siteOrigin);
  if (
    !source(executorSha) ||
    !run(sourceRunId) ||
    !isHash(previousActivationHash) ||
    !['get', 'set', 'getHistory', 'putHistory'].every(
      (method) => typeof registry?.[method] === 'function',
    ) ||
    typeof read !== 'function' ||
    !timestamp(now())
  )
    throw Error('Exact recovery executor, prior activation and registry required');

  const state = observation(await read());
  let row = await registry.get();
  if (row !== null && typeof row === 'object' && '_id' in row)
    throw Error('Internal catalog recovery records must have normalized document identifiers');
  if (row?.schemaVersion === 2 && row.previousActivationHash === previousActivationHash) {
    assertRecoveryRecord(row, siteOrigin, now());
    if (row.executorSha !== executorSha || !sameState(row, state))
      throw Error('Saved catalog recovery differs from this executor or writer state');
    await requireHistory(registry, previousActivationHash);
  } else {
    assertCatalogRuntimeProof(row, siteOrigin, now());
    if (identity(row) !== previousActivationHash)
      throw Error('Previous activation differs from the explicitly selected proof');
    await preserveHistory(registry, previousActivationHash, row);
    if (identity((await registry.get()) ?? null) !== previousActivationHash)
      throw Error('Previous activation changed before recovery was recorded');
    const observedAt = now();
    row = {
      schemaVersion: 2,
      purpose,
      siteOrigin,
      executorSha,
      sourceRunId,
      previousActivationHash,
      ...state,
      observedAt,
      usableAfter: observedAt + (state.maximumTimeoutSeconds + 120) * 1000,
      accepted: false,
    };
    assertRecoveryRecord(row, siteOrigin, now());
    await storeExact(registry, row);
  }
  if (row.accepted) return assertCatalogRuntimeProof(row, siteOrigin, now());

  while (now() < row.usableAfter) {
    const before = now();
    report({
      stage: 'waiting-for-prior-writer-requests',
      remainingSeconds: Math.ceil((row.usableAfter - before) / 1000),
    });
    await wait(Math.min(30_000, row.usableAfter - before));
    if (!timestamp(now()) || now() <= before)
      throw Error('Recovery clock did not advance through the waiting window');
  }
  if (!sameState(state, observation(await read())))
    throw Error('Catalog writer state changed during its recovery window');
  if (identity((await registry.get()) ?? null) !== identity(row))
    throw Error('Catalog activation changed during its recovery window');
  row = { ...row, accepted: true, acceptedAt: now() };
  assertCatalogRuntimeProof(row, siteOrigin, now());
  await storeExact(registry, row);
  return row;
}

/** Schema 1 remains readable; schema 2 identifies each running writer independently. */
export function assertCatalogRuntimeProof(row, siteOrigin, now = Date.now()) {
  if (row?.schemaVersion === 2) {
    assertRecoveryRecord(row, siteOrigin, now);
    if (row.accepted !== true)
      throw Error('Catalog writer recovery has not finished; do not build tracked HTML yet');
    return row;
  }
  // Preserve the original initial-activation checks for already archived programs.
  if (
    row?.schemaVersion !== 1 ||
    row.purpose !== 'initial-catalog-runtime' ||
    row.siteOrigin !== siteOrigin ||
    row.accepted !== true ||
    !/^[a-f0-9]{40}$/.test(row.codeSha ?? '') ||
    !/^[1-9][0-9]*$/.test(row.sourceRunId ?? '') ||
    !isHash(row.configurationHash) ||
    !Number.isSafeInteger(row.observedAt) ||
    !Number.isSafeInteger(row.usableAfter) ||
    !Number.isSafeInteger(row.acceptedAt) ||
    !boundedTimeout(row.maximumTimeoutSeconds) ||
    row.usableAfter !== row.observedAt + (row.maximumTimeoutSeconds + 120) * 1000 ||
    row.acceptedAt < row.usableAfter ||
    row.acceptedAt > now
  )
    throw Error(
      'Initial catalog writer activation has not finished; do not build tracked HTML yet',
    );
  return row;
}

function assertRecoveryRecord(row, siteOrigin, now) {
  assertOrigin(siteOrigin);
  const keys = [
    'schemaVersion',
    'purpose',
    'siteOrigin',
    'executorSha',
    'sourceRunId',
    'previousActivationHash',
    'configurationHash',
    'maximumTimeoutSeconds',
    'writerVersions',
    'observedAt',
    'usableAfter',
    'accepted',
    ...(row?.accepted === true ? ['acceptedAt'] : []),
  ];
  if (
    !exactKeys(row, keys) ||
    row.schemaVersion !== 2 ||
    row.purpose !== purpose ||
    row.siteOrigin !== siteOrigin ||
    !source(row.executorSha) ||
    !run(row.sourceRunId) ||
    !isHash(row.previousActivationHash) ||
    !isHash(row.configurationHash) ||
    !boundedTimeout(row.maximumTimeoutSeconds) ||
    !writerVersions(row.writerVersions) ||
    !timestamp(now) ||
    !timestamp(row.observedAt) ||
    row.observedAt > now ||
    !timestamp(row.usableAfter) ||
    row.usableAfter !== row.observedAt + (row.maximumTimeoutSeconds + 120) * 1000 ||
    typeof row.accepted !== 'boolean' ||
    (row.accepted &&
      (!timestamp(row.acceptedAt) || row.acceptedAt < row.usableAfter || row.acceptedAt > now))
  )
    throw Error('Invalid or premature catalog writer recovery proof');
}

function observation(value) {
  if (
    !exactKeys(value, ['configurationHash', 'maximumTimeoutSeconds', 'writerVersions']) ||
    !isHash(value.configurationHash) ||
    !boundedTimeout(value.maximumTimeoutSeconds) ||
    !writerVersions(value.writerVersions)
  )
    throw Error('Bounded configuration and actual writer versions required for recovery');
  return structuredClone(value);
}
function writerVersions(value) {
  return (
    Array.isArray(value) &&
    value.length === writers.length &&
    value.every(
      (entry, index) =>
        exactKeys(entry, ['name', 'releaseId']) &&
        entry.name === writers[index] &&
        source(entry.releaseId),
    )
  );
}
function sameState(left, right) {
  const state = (value) => ({
    configurationHash: value.configurationHash,
    maximumTimeoutSeconds: value.maximumTimeoutSeconds,
    writerVersions: value.writerVersions,
  });
  return identity(state(left)) === identity(state(right));
}
function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}
async function preserveHistory(registry, hash, row) {
  const existing = await registry.getHistory(hash);
  if (existing !== null && existing !== undefined) {
    if (identity(existing) !== hash) throw Error('Immutable activation history differs');
    return;
  }
  try {
    await registry.putHistory(hash, row);
  } catch {
    // Readback settles this exact write; never retry an uncertain history write.
  }
  await requireHistory(registry, hash);
}
async function requireHistory(registry, hash) {
  if (identity((await registry.getHistory(hash)) ?? null) !== hash)
    throw Error('Activation history needs exact readback');
}
async function storeExact(registry, row) {
  try {
    await registry.set(row);
  } catch {
    // The registry owns the compare-and-set boundary; only exact readback settles a lost reply.
  }
  if (identity((await registry.get()) ?? null) !== identity(row))
    throw Error('Catalog recovery state needs exact readback');
}
