import assert from 'node:assert/strict';

const errorCodes = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ERR_ASSERTION',
  'PROBE_BOOTSTRAP_FAILED',
  'PROBE_TRANSACTION_FAILED',
  'PROBE_TIMEOUT',
  'PROBE_CLEANUP_FAILED',
]);

function probeError(code) {
  const error = new Error('Catalog taxonomy probe failed');
  error.code = code;
  return error;
}

export function probeFailure(error) {
  return {
    phase: 'probe-failed',
    code: errorCodes.has(error?.code) ? error.code : 'PROBE_FAILED',
  };
}

export function bootstrapProbe({ envId, allowIsolatedWrites, cli, loadSdk }) {
  try {
    if (!envId || !allowIsolatedWrites) throw probeError('PROBE_BOOTSTRAP_FAILED');
    const envelope = JSON.parse(cli(['secrets', 'get', '--json']));
    const credentials = envelope.data ?? envelope;
    if (
      ![credentials.secretId, credentials.secretKey, credentials.token].every(
        (value) => typeof value === 'string' && value.length > 0,
      )
    ) {
      throw probeError('PROBE_BOOTSTRAP_FAILED');
    }
    return loadSdk()
      .init({
        env: envId,
        region: 'ap-shanghai',
        secretId: credentials.secretId,
        secretKey: credentials.secretKey,
        sessionToken: credentials.token,
        timeout: 15000,
      })
      .database();
  } catch {
    throw probeError('PROBE_BOOTSTRAP_FAILED');
  }
}

export async function runTransactionProbe({
  database,
  collectionName,
  registryId,
  timeoutMs = 60000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let aborted = false;
  let timedOut = false;
  let arrived = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const abort = () => {
    aborted = true;
    release();
  };
  const checkAborted = () => {
    if (aborted) throw probeError('PROBE_TRANSACTION_FAILED');
  };
  const save = async () => {
    try {
      return await database.runTransaction(async (transaction) => {
        checkAborted();
        const ref = transaction.collection(collectionName).doc(registryId);
        const result = await ref.get();
        checkAborted();
        const row = Array.isArray(result.data) ? result.data[0] : result.data;
        if (row?.revision !== 0) return 'conflict';
        arrived++;
        if (arrived >= 2) release();
        await barrier;
        checkAborted();
        await ref.set({ revision: 1 });
        return 'saved';
      });
    } catch {
      abort();
      throw probeError('PROBE_TRANSACTION_FAILED');
    }
  };
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimer(() => {
      timedOut = true;
      abort();
      reject(probeError('PROBE_TIMEOUT'));
    }, timeoutMs);
  });
  const settled = Promise.allSettled([save(), save()]);
  try {
    const results = await Promise.race([settled, deadline]);
    if (results.some((result) => result.status === 'rejected')) {
      throw probeError('PROBE_TRANSACTION_FAILED');
    }
    const outcomes = results.map((result) => result.value).sort();
    assert.deepEqual(outcomes, ['conflict', 'saved']);
    return outcomes;
  } catch {
    throw probeError(timedOut ? 'PROBE_TIMEOUT' : 'PROBE_TRANSACTION_FAILED');
  } finally {
    abort();
    clearTimer(timeout);
    await settled;
  }
}

export async function cleanupProbe({
  collection,
  collectionName,
  writtenIds,
  retry = (operation) => operation(),
  log = () => {},
}) {
  let cleaned = 0;
  let remaining = null;
  let failed = false;
  for (const id of writtenIds) {
    try {
      await retry(() => collection.doc(id).remove());
      cleaned++;
    } catch {
      failed = true;
    }
  }
  try {
    const result = await retry(() => collection.count());
    if (!Number.isSafeInteger(result.total) || result.total < 0) {
      throw probeError('PROBE_CLEANUP_FAILED');
    }
    remaining = result.total;
    if (remaining !== 0) failed = true;
  } catch {
    failed = true;
  }
  log({
    phase: 'cleanup',
    collectionName,
    expected: writtenIds.length,
    cleaned,
    remaining,
    emptyCollectionRetained: true,
  });
  if (failed) throw probeError('PROBE_CLEANUP_FAILED');
}
