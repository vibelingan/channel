import { setTimeout as pause } from 'node:timers/promises';
import { identity, isHash } from './input.mjs';
const purpose = 'initial-catalog-runtime';
/** Only the initial switch from untracked writers needs this wait. Ordinary tracked releases do not repeat it. */
export async function settleInitialCatalogRuntime({
  registry,
  siteOrigin,
  codeSha,
  sourceRunId,
  read,
  now = Date.now,
  wait = pause,
  report = (_event) => {},
}) {
  if (!/^[a-f0-9]{40}$/.test(codeSha) || !/^[1-9][0-9]*$/.test(sourceRunId ?? ''))
    throw Error('Exact catalog runtime source required');
  const observed = await read();
  const state = {
    configurationHash: observed.configurationHash,
    maximumTimeoutSeconds: observed.maximumTimeoutSeconds,
  };
  if (
    !isHash(state.configurationHash) ||
    !Number.isSafeInteger(state.maximumTimeoutSeconds) ||
    state.maximumTimeoutSeconds < 1 ||
    state.maximumTimeoutSeconds > 900
  )
    throw Error('Bounded current writer configuration required');
  let row = await registry.get();
  if (row) {
    if (
      row.purpose !== purpose ||
      row.schemaVersion !== 1 ||
      row.siteOrigin !== siteOrigin ||
      row.codeSha !== codeSha ||
      row.configurationHash !== state.configurationHash ||
      row.maximumTimeoutSeconds !== state.maximumTimeoutSeconds
    )
      throw Error('Initial catalog activation differs; inspect its original record');
  } else {
    const observedAt = now();
    row = {
      schemaVersion: 1,
      purpose,
      siteOrigin,
      codeSha,
      sourceRunId,
      ...state,
      observedAt,
      usableAfter: observedAt + (state.maximumTimeoutSeconds + 120) * 1000,
      accepted: false,
    };
    await store(registry, row);
  }
  if (
    typeof row.accepted !== 'boolean' ||
    !/^[1-9][0-9]*$/.test(row.sourceRunId ?? '') ||
    !Number.isSafeInteger(row.observedAt) ||
    row.observedAt < 0 ||
    !Number.isSafeInteger(row.usableAfter) ||
    row.usableAfter !== row.observedAt + (row.maximumTimeoutSeconds + 120) * 1000 ||
    row.observedAt > now()
  )
    throw Error('Invalid catalog activation wait record');
  if (row.accepted) {
    assertInitialCatalogRuntime(row, siteOrigin, now());
    return row;
  }
  while (now() < row.usableAfter) {
    report({
      stage: 'waiting-for-prior-writer-requests',
      remainingSeconds: Math.ceil((row.usableAfter - now()) / 1000),
    });
    await wait(Math.min(30000, row.usableAfter - now()));
  }
  const after = await read();
  if (
    identity({
      configurationHash: after.configurationHash,
      maximumTimeoutSeconds: after.maximumTimeoutSeconds,
    }) !== identity(state)
  )
    throw Error('Catalog runtime changed during its initial activation window');
  row = { ...row, accepted: true, acceptedAt: now() };
  await store(registry, row);
  return row;
}
export function assertInitialCatalogRuntime(row, siteOrigin, now = Date.now()) {
  if (
    row?.schemaVersion !== 1 ||
    row.purpose !== purpose ||
    row.siteOrigin !== siteOrigin ||
    row.accepted !== true ||
    !/^[a-f0-9]{40}$/.test(row.codeSha ?? '') ||
    !/^[1-9][0-9]*$/.test(row.sourceRunId ?? '') ||
    !isHash(row.configurationHash) ||
    !Number.isSafeInteger(row.observedAt) ||
    !Number.isSafeInteger(row.usableAfter) ||
    !Number.isSafeInteger(row.acceptedAt) ||
    !Number.isSafeInteger(row.maximumTimeoutSeconds) ||
    row.maximumTimeoutSeconds < 1 ||
    row.maximumTimeoutSeconds > 900 ||
    row.usableAfter !== row.observedAt + (row.maximumTimeoutSeconds + 120) * 1000 ||
    row.acceptedAt < row.usableAfter ||
    row.acceptedAt > now
  )
    throw Error(
      'Initial catalog writer activation has not finished; do not build tracked HTML yet',
    );
  return row;
}
async function store(registry, row) {
  try {
    await registry.set(row);
  } catch {
    /* Readback settles this exact state; no blind write retry. */
  }
  if (identity(await registry.get()) !== identity(row))
    throw Error('Catalog activation state needs readback');
}
