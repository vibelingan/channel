import { createHash, timingSafeEqual } from 'node:crypto';
import { identity } from './input.mjs';
import { assertTarget, id, jsonCopy, normalizePolicy } from './ledger.mjs';
import { SITE_DELIVERY_POLICY } from './site-policy.mjs';
import { createReleaseCoordinator } from './state.mjs';
import { createCloudbaseReleaseStore } from './store-cloudbase.mjs';

export const releaseRegionalPurpose = 'release-regional-v1';
export const releaseRegionalMethods = Object.freeze([
  'beginStep',
  'recordSubmitted',
  'confirmStep',
  'markUnknown',
  'failStep',
  'failRun',
  'commitRun',
  'resumeReadOnlyAcceptance',
  'reconcile',
  'runStatus',
  'startRun',
  'acquire',
  'renew',
  'releaseFailedSite',
  'release',
  'status',
]);
export const releaseRegionalReads = new Set(['health', 'status', 'runStatus', 'operation.get']);
const expectedPolicy = normalizePolicy(SITE_DELIVERY_POLICY);
const knownCodes = new Set([
  'TARGET_UNINITIALIZED',
  'TARGET_POLICY_MISMATCH',
  'LEASE_LOST',
  'LEASE_BUSY',
  'LEASE_STALLED',
  'UNRESOLVED_OPERATION',
  'RUN_NOT_FOUND',
  'RUN_NOT_RUNNING',
  'RUN_CONFLICT',
  'RECOVERY_REQUIRED',
  'BASELINE_REQUIRED',
  'BASELINE_ALREADY_EXISTS',
  'STEP_NOT_FOUND',
  'STEP_NOT_PENDING',
  'CORRUPT_STEP',
  'INVALID_RECEIPT',
  'INVALID_RECONCILIATION',
  'READ_ONLY_ACCEPTANCE_REQUIRED',
  'INVALID_SCOPE',
  'INVALID_BATCH_INTENT',
  'INVALID_PLAN',
  'INVALID_RUN_KIND',
  'INVALID_FAILED_RUN',
  'INVALID_RESTORE_SOURCE',
  'INVALID_COMPOSITION',
  'INVALID_COMPONENT_SELECTION',
  'INVALID_ARTIFACT_REF',
  'ARTIFACT_EXPIRED',
  'INVALID_ID',
  'INVALID_TEXT',
  'INVALID_STEP',
  'STEP_CONFLICT',
  'STEP_SEQUENCE',
  'RUN_INCOMPLETE',
  'RELEASE_REGIONAL_REQUEST',
  'RELEASE_REGIONAL_IDENTITY',
  'RELEASE_REGIONAL_AUTH',
  'RELEASE_REGIONAL_RECEIPT',
  'RELEASE_REGIONAL_OPERATION_FAILED',
  'ACCEPTANCE_REQUIRED',
  'CANARY_INITIALIZATION_ONLY',
  'COMMIT_CONFLICT',
  'CORRUPT_BASELINE',
  'CORRUPT_PENDING_OPERATION',
  'CORRUPT_COUNTER',
  'CORRUPT_LEASE',
  'CORRUPT_SCOPE',
  'INVALID_STEP_ORDER',
  'STALE_ACTIVATION',
  'STEP_ORDER_CONFLICT',
  'STEP_REQUIRES_READBACK',
  'STEP_TERMINAL',
  'STORE_ENV_MISMATCH',
  'UNDELIVERED_COMPONENT',
  'LEDGER_SIZE_LIMIT',
]);
const sdkCodes = new Set([
  'ResourceUnavailable.TransactionNotExist',
  'DATABASE_TRANSACTION_FAIL',
  'DATABASE_TRANSACTION_CONFLICT',
  'DATABASE_PERMISSION_DENIED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
]);
const error = (code) => Object.assign(Error(code), { code });
const check = (condition, code = 'RELEASE_REGIONAL_REQUEST') => {
  if (!condition) throw error(code);
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function releaseRegionalInputHash(request) {
  return identity({
    schemaVersion: request.schemaVersion,
    ownerRunId: request.ownerRunId,
    runnerRef: request.runnerRef,
    codeSha: request.codeSha,
    targetId: request.targetId,
    operationId: request.operationId,
    method: request.method,
    args: request.args,
  });
}

export function validateReleaseRegionalConfig(config) {
  check(config.envId === SITE_DELIVERY_POLICY.envId, 'RELEASE_REGIONAL_IDENTITY');
  check(config.targetId === expectedPolicy.targetId, 'RELEASE_REGIONAL_IDENTITY');
  id(config.ownerRunId);
  const runner = /^github:vibelingan\/channel:([1-9][0-9]{7,19}):attempt-([1-9][0-9]*)$/.exec(
    config.runnerRef,
  );
  check(runner, 'RELEASE_REGIONAL_IDENTITY');
  check(
    new RegExp(`^(?:site|readback|site-archive|reconcile)-${runner[1]}-${runner[2]}$`).test(
      config.ownerRunId,
    ),
    'RELEASE_REGIONAL_IDENTITY',
  );
  check(/^[a-f0-9]{40}$/.test(config.codeSha), 'RELEASE_REGIONAL_IDENTITY');
  check(/^[a-f0-9]{64}$/.test(config.tokenDigest), 'RELEASE_REGIONAL_IDENTITY');
  return `seo-release-region-${runner[1]}-${runner[2]}`;
}

export function releaseRegionalDiagnostic(cause) {
  const diagnostic = {};
  const sdkCode = cause?.sdkCode ?? cause?.code;
  if (sdkCodes.has(sdkCode)) diagnostic.sdkCode = sdkCode;
  const requestId = cause?.requestId ?? cause?.RequestId;
  if (typeof requestId === 'string' && /^[a-f0-9-]{16,64}$/i.test(requestId))
    diagnostic.requestId = requestId;
  if (
    /^(?:awaiting-sdk-transaction|callback-entered|callback-completed|(?:read|write):(?:targets|scopes|runs|steps)|receipt-read|receipt-write)$/.test(
      cause?.ledgerStage ?? '',
    )
  )
    diagnostic.ledgerStage = cause.ledgerStage;
  return diagnostic;
}

function validateRequest(input, config) {
  check(
    exactKeys(input, [
      'schemaVersion',
      'token',
      'ownerRunId',
      'runnerRef',
      'codeSha',
      'targetId',
      'operationId',
      'method',
      'args',
      'inputHash',
    ]),
  );
  const request = jsonCopy(input);
  check(request.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(request.token));
  const digest = createHash('sha256').update(request.token).digest();
  check(timingSafeEqual(digest, Buffer.from(config.tokenDigest, 'hex')), 'RELEASE_REGIONAL_AUTH');
  for (const key of ['ownerRunId', 'runnerRef', 'codeSha', 'targetId'])
    check(request[key] === config[key], 'RELEASE_REGIONAL_IDENTITY');
  id(request.operationId);
  check([...releaseRegionalMethods, 'health', 'operation.get'].includes(request.method));
  check(Array.isArray(request.args) && request.args.length <= 2);
  check(request.inputHash === releaseRegionalInputHash(request));
  const first = request.args[0];
  const guard =
    request.method === 'renew' ||
    request.method === 'release' ||
    request.method === 'releaseFailedSite'
      ? first
      : first?.guard;
  if (guard) {
    check(
      guard.targetId === config.targetId && guard.ownerRunId === config.ownerRunId,
      'RELEASE_REGIONAL_IDENTITY',
    );
  }
  if (request.method === 'acquire')
    check(
      exactKeys(first, ['ownerRunId', 'runnerRef']) &&
        first.ownerRunId === config.ownerRunId &&
        first.runnerRef === config.runnerRef,
      'RELEASE_REGIONAL_IDENTITY',
    );
  if (request.method === 'resumeReadOnlyAcceptance')
    check(
      first?.ownerRunId === config.ownerRunId && first.runnerRef === config.runnerRef,
      'RELEASE_REGIONAL_IDENTITY',
    );
  if (['health', 'status'].includes(request.method))
    check(request.args.length <= (request.method === 'health' ? 0 : 1));
  else check(request.args.length === (request.method === 'releaseFailedSite' ? 2 : 1));
  if (request.method === 'status' && first !== undefined)
    check(
      object(first) &&
        Object.keys(first).every((key) => key === 'scopeKey') &&
        (first.scopeKey === undefined || ['site', 'canary'].includes(first.scopeKey)),
    );
  if (request.method === 'runStatus') id(first);
  if (request.method === 'operation.get')
    check(
      exactKeys(first, ['operationId', 'inputHash', 'method']) &&
        /^[a-f0-9]{64}$/.test(first.inputHash) &&
        releaseRegionalMethods.includes(first.method) &&
        !releaseRegionalReads.has(first.method) &&
        id(first.operationId),
    );
  return request;
}

function receiptKey(config, operationId) {
  return `release-op-${identity({ targetId: config.targetId, ownerRunId: config.ownerRunId, operationId })}`;
}
function readReceipt(row, config, request) {
  check(
    row?.schemaVersion === 1 &&
      row.purpose === releaseRegionalPurpose &&
      row.ownerRunId === config.ownerRunId &&
      row.targetId === config.targetId &&
      row.runnerRef === config.runnerRef &&
      row.codeSha === config.codeSha &&
      row.operationId === request.operationId &&
      row.inputHash === request.inputHash &&
      row.method === request.method &&
      Object.hasOwn(row, 'result'),
    'RELEASE_REGIONAL_RECEIPT',
  );
  return jsonCopy(row.result);
}
const terminalMethods = new Set([
  'commitRun',
  'release',
  'releaseFailedSite',
  'failStep',
  'failRun',
  'reconcile',
]);
function authorityFor(request, result) {
  if (terminalMethods.has(request.method)) return null;
  const input = request.args[0];
  const guard = ['acquire', 'renew', 'resumeReadOnlyAcceptance'].includes(request.method)
    ? result
    : input?.guard;
  return {
    guard,
    ...(input?.runId ? { runId: input.runId } : {}),
    ...(input?.stepId ? { stepId: input.stepId } : {}),
  };
}
async function nativeRow(tx, collection, key) {
  const result = await tx.collection(collection).doc(key).get();
  check(
    result &&
      !result.code &&
      Object.hasOwn(result, 'data') &&
      (result.data === null || object(result.data)),
    'RELEASE_REGIONAL_OPERATION_FAILED',
  );
  if (result.data === null) return null;
  const { _id, ...row } = result.data;
  check(_id === undefined || _id === key, 'RELEASE_REGIONAL_RECEIPT');
  return row;
}
async function assertReceiptAuthority(tx, row, config, now) {
  if (terminalMethods.has(row.method)) return;
  const authority = row.authority;
  const guard = authority?.guard;
  const target = await nativeRow(tx, 'siteReleaseTargets', config.targetId);
  check(target, 'LEASE_LOST');
  assertTarget(target, expectedPolicy);
  check(
    guard?.targetId === config.targetId &&
      guard.ownerRunId === config.ownerRunId &&
      target.lease?.ownerRunId === config.ownerRunId &&
      target.lease.runnerRef === config.runnerRef &&
      target.lease.fence === guard.fence &&
      target.lease.acquiredVersion === guard.acquiredVersion &&
      now() < target.lease.expiresAt,
    'LEASE_LOST',
  );
  if (!authority.runId) return;
  const run = await nativeRow(
    tx,
    'siteReleaseRuns',
    identity({ targetId: config.targetId, runId: authority.runId }),
  );
  check(
    run?.schemaVersion === 1 &&
      run.targetId === config.targetId &&
      run.runId === authority.runId &&
      run.ownerRunId === guard.ownerRunId &&
      run.fence === guard.fence &&
      run.acquiredVersion === guard.acquiredVersion &&
      run.state === 'RUNNING' &&
      target.currentRunId === run.runId,
    'LEASE_LOST',
  );
  if (!authority.stepId) {
    check(now() < target.lease.expiresAt, 'LEASE_LOST');
    return;
  }
  const step = await nativeRow(
    tx,
    'siteReleaseSteps',
    identity({ targetId: config.targetId, runId: authority.runId, stepId: authority.stepId }),
  );
  check(
    step?.targetId === config.targetId &&
      step.runId === run.runId &&
      step.stepId === authority.stepId &&
      step.fence === guard.fence &&
      step.operationId === row.result.operationId,
    'RELEASE_REGIONAL_RECEIPT',
  );
  if (row.method === 'confirmStep') {
    check(
      step.state === 'verified' &&
        step.intentHash === row.result.intentHash &&
        step.sequence < run.verifiedSteps &&
        target.unresolvedOperation === null,
      'RELEASE_REGIONAL_RECEIPT',
    );
  } else {
    check(
      target.unresolvedOperation?.runId === run.runId &&
        target.unresolvedOperation.stepId === step.stepId &&
        target.unresolvedOperation.operationId === step.operationId &&
        (row.method === 'markUnknown'
          ? step.state === 'unknown'
          : step.state === row.result.state && step.intentHash === row.result.intentHash),
      'RELEASE_REGIONAL_RECEIPT',
    );
  }
  check(now() < target.lease.expiresAt, 'LEASE_LOST');
}
async function getReceipt(tx, key) {
  return nativeRow(tx, 'catalogSeoBuilders', key);
}

/** The original ledger callback and its RPC receipt share one native transaction. */
export function createReleaseRegionalHandler(
  config,
  {
    createDatabase,
    now = Date.now,
    onStatus = (row) => console.log(JSON.stringify({ event: 'release-regional', ...row })),
  },
) {
  validateReleaseRegionalConfig(config);
  return async (input) => {
    const started = now();
    let request;
    try {
      request = validateRequest(input, config);
      const success = (result) => ({
        purpose: releaseRegionalPurpose,
        envId: config.envId,
        targetId: config.targetId,
        ownerRunId: config.ownerRunId,
        runnerRef: config.runnerRef,
        codeSha: config.codeSha,
        operationId: request.operationId,
        inputHash: request.inputHash,
        method: request.method,
        ok: true,
        result: result ?? null,
      });
      if (request.method === 'health') return success({ ready: true });
      const db = createDatabase();
      check(
        db?.config?.env === config.envId && typeof db.runTransaction === 'function',
        'RELEASE_REGIONAL_IDENTITY',
      );
      if (request.method === 'operation.get') {
        const original = request.args[0];
        const result = await db.runTransaction(async (tx) => {
          const row = await getReceipt(tx, receiptKey(config, original.operationId));
          if (row === null) return { state: 'absent' };
          const result = readReceipt(row, config, original);
          await assertReceiptAuthority(tx, row, config, now);
          return {
            state: 'completed',
            operationId: original.operationId,
            inputHash: original.inputHash,
            method: original.method,
            result,
          };
        });
        return success(result);
      }
      const writing = !releaseRegionalReads.has(request.method);
      let transactionCalls = 0;
      const wrapped = {
        config: db.config,
        runTransaction: (callback) => {
          check(++transactionCalls === 1, 'RELEASE_REGIONAL_OPERATION_FAILED');
          return db.runTransaction(async (tx) => {
            const key = receiptKey(config, request.operationId);
            const existing = writing ? await getReceipt(tx, key) : null;
            if (existing) {
              const result = readReceipt(existing, config, request);
              await assertReceiptAuthority(tx, existing, config, now);
              return result;
            }
            const value = await callback(tx);
            const result = value ?? null;
            if (writing) {
              const row = {
                schemaVersion: 1,
                purpose: releaseRegionalPurpose,
                ownerRunId: config.ownerRunId,
                targetId: config.targetId,
                runnerRef: config.runnerRef,
                codeSha: config.codeSha,
                operationId: request.operationId,
                inputHash: request.inputHash,
                method: request.method,
                result: jsonCopy(result),
                authority: jsonCopy(authorityFor(request, result)),
              };
              const stored = await tx.collection('catalogSeoBuilders').doc(key).set(row);
              check(
                !stored?.code &&
                  typeof stored?.requestId === 'string' &&
                  stored.requestId &&
                  (stored.updated === 1 || stored.upserted?.some((item) => item._id === key)),
                'RELEASE_REGIONAL_OPERATION_FAILED',
              );
            }
            return result;
          });
        },
      };
      const coordinator = createReleaseCoordinator({
        store: createCloudbaseReleaseStore({ db: wrapped, envId: config.envId }),
        policy: SITE_DELIVERY_POLICY,
        clock: now,
      });
      const result = await coordinator[request.method](...request.args);
      try {
        onStatus({ method: request.method, elapsedMs: now() - started, ok: true });
      } catch {}
      return success(result);
    } catch (cause) {
      const code = knownCodes.has(cause?.code) ? cause.code : 'RELEASE_REGIONAL_OPERATION_FAILED';
      const diagnostic = releaseRegionalDiagnostic(cause);
      try {
        onStatus({
          method: request?.method ?? 'invalid',
          elapsedMs: now() - started,
          ok: false,
          ...diagnostic,
        });
      } catch {}
      return {
        purpose: releaseRegionalPurpose,
        envId: config.envId,
        targetId: config.targetId,
        ownerRunId: config.ownerRunId,
        runnerRef: config.runnerRef,
        codeSha: config.codeSha,
        operationId: request?.operationId ?? null,
        inputHash: request?.inputHash ?? null,
        method: request?.method ?? null,
        ok: false,
        error: { code, message: code, diagnostic },
      };
    }
  };
}
