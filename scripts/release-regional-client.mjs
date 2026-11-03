import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { buildReleaseRegional } from './release-regional-build.mjs';
import { readCompleteFunctionInventory } from './release/function-inventory.mjs';
import { normalizePolicy } from './release/ledger.mjs';
import {
  releaseRegionalDiagnostic,
  releaseRegionalInputHash,
  releaseRegionalPurpose,
  releaseRegionalReads,
  validateReleaseRegionalConfig,
} from './release/regional-coordinator.mjs';
import { SITE_DELIVERY_POLICY } from './release/site-policy.mjs';

const description = 'channel-release-regional-v1';
const unconfirmedError = (diagnostic = {}) =>
  Object.assign(
    Error('Release ledger completion needs readback; retain its regional function and lease'),
    { code: 'RELEASE_REGIONAL_UNCONFIRMED', ...diagnostic, diagnostic },
  );

/** Only the temporary Event function changes; release policy and ledger rules remain server-owned. */
export async function createReleaseRegionalClient({
  manager,
  policy,
  ownerRunId,
  runnerRef,
  codeSha,
  directory,
  build = buildReleaseRegional,
  wait = pause,
  mask = (token) => {
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${token}`);
  },
  onStatus = (event) => console.log(JSON.stringify({ event: 'release-regional', ...event })),
}) {
  assert.equal(policy.repository, SITE_DELIVERY_POLICY.repository);
  assert.equal(policy.envId, SITE_DELIVERY_POLICY.envId);
  assert.equal(policy.region, SITE_DELIVERY_POLICY.region);
  assert.equal(policy.siteOrigin, SITE_DELIVERY_POLICY.siteOrigin);
  const selected = manager.getManagerConfig();
  assert.equal(selected.envId, policy.envId);
  assert.equal(selected.region, policy.region);
  const token = randomBytes(32).toString('hex');
  const config = {
    envId: policy.envId,
    targetId: normalizePolicy(policy).targetId,
    ownerRunId,
    runnerRef,
    codeSha,
    tokenDigest: createHash('sha256').update(token).digest('hex'),
  };
  const name = validateReleaseRegionalConfig(config);
  mask(token);
  let unknown = false;
  let creationStarted = false;
  let created = false;
  let closed = false;
  const receipt = {
    schemaVersion: 1,
    purpose: releaseRegionalPurpose,
    environment: policy.envId,
    targetId: config.targetId,
    ownerRunId,
    runnerRef,
    codeSha,
    functionName: name,
    created: false,
    cleaned: false,
    unconfirmed: false,
    websiteWrites: 0,
    businessWrites: 0,
    calls: [],
  };
  const persist = async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'result.json'), JSON.stringify(receipt, null, 2), {
      mode: 0o600,
    });
  };
  const notify = (row) => {
    try {
      onStatus(row);
    } catch {}
  };
  const markUnknown = async (diagnostic = {}) => {
    unknown = true;
    receipt.cleaned = false;
    receipt.unconfirmed = true;
    await persist();
    throw unconfirmedError(diagnostic);
  };
  const inventory = () => readCompleteFunctionInventory(manager.functions, policy.envId);
  const expectedVariables = {
    TCB_ENV: config.envId,
    RELEASE_REGIONAL_TARGET_ID: config.targetId,
    RELEASE_REGIONAL_OWNER_RUN_ID: ownerRunId,
    RELEASE_REGIONAL_RUNNER_REF: runnerRef,
    RELEASE_REGIONAL_TOKEN_DIGEST: config.tokenDigest,
    RELEASE_REGIONAL_SITE_ORIGIN: policy.siteOrigin,
    RELEASE_REGIONAL_REPOSITORY: policy.repository,
  };
  const own = (detail) => {
    assert.equal(detail.FunctionName, name);
    assert.equal(detail.Description, description);
    assert.equal(detail.Runtime, 'Nodejs20.19');
    assert.equal(detail.Type, 'Event');
    assert.equal(detail.Handler, 'index.main');
    assert.deepEqual(detail.Triggers ?? [], []);
    const vars = Object.fromEntries(
      (detail.Environment?.Variables ?? []).map(({ Key, Value }) => [Key, Value]),
    );
    for (const [key, expected] of Object.entries(expectedVariables))
      assert.equal(vars[key], expected);
  };
  const requestFor = (method, args) => {
    const request = {
      schemaVersion: 1,
      token,
      ownerRunId,
      runnerRef,
      codeSha,
      targetId: config.targetId,
      operationId: randomUUID(),
      method,
      args,
    };
    return { ...request, inputHash: releaseRegionalInputHash(request) };
  };
  const validateResult = (request, result) => {
    assert.ok(result && typeof result === 'object' && !Array.isArray(result));
    if (['acquire', 'renew', 'resumeReadOnlyAcceptance'].includes(request.method)) {
      assert.equal(result.targetId, config.targetId);
      assert.equal(result.ownerRunId, ownerRunId);
      assert.ok(Number.isSafeInteger(result.fence) && result.fence > 0);
      assert.ok(Number.isSafeInteger(result.acquiredVersion) && result.acquiredVersion >= 0);
    }
    if (['status', 'runStatus', 'startRun', 'beginStep'].includes(request.method))
      assert.equal(result.targetId, config.targetId);
  };
  const terminal = (response, request) => {
    assert.ok(response && typeof response.RequestId === 'string' && response.RequestId);
    assert.equal(typeof response.RetMsg, 'string');
    assert.ok(Buffer.byteLength(response.RetMsg) <= 1024 * 1024);
    assert.ok(response.InvokeFinished === undefined || response.InvokeFinished === 1);
    assert.ok(response.RetCode === undefined || response.RetCode === 0);
    assert.ok(!response.ErrMsg?.trim());
    const value = JSON.parse(response.RetMsg);
    assert.equal(value.purpose, releaseRegionalPurpose);
    for (const key of ['envId', 'targetId', 'ownerRunId', 'runnerRef', 'codeSha'])
      assert.equal(value[key], config[key]);
    for (const key of ['operationId', 'inputHash', 'method'])
      assert.equal(value[key], request[key]);
    assert.equal(typeof value.ok, 'boolean');
    if (value.ok) validateResult(request, value.result);
    return value;
  };
  const invoke = async (method, args) => {
    assert.equal(closed, false, 'Release regional client is closed');
    assert.equal(unknown, false, 'Unconfirmed release operation needs readback');
    const request = requestFor(method, method === 'renew' ? structuredClone(args) : args);
    const started = Date.now();
    let value;
    let state = 'completed';
    let diagnostic = {};
    try {
      value = terminal(await manager.functions.invokeFunction(name, request), request);
      if (!value.ok) diagnostic = releaseRegionalDiagnostic(value.error?.diagnostic);
      if (!value.ok && value.error?.code === 'RELEASE_REGIONAL_OPERATION_FAILED')
        throw Error('Completion needs receipt');
    } catch (cause) {
      diagnostic = { ...releaseRegionalDiagnostic(cause), ...diagnostic };
      let retryCompleted = false;
      try {
        if (releaseRegionalReads.has(method)) {
          value = terminal(await manager.functions.invokeFunction(name, request), request);
        } else {
          const readback = requestFor('operation.get', [
            { operationId: request.operationId, inputHash: request.inputHash, method },
          ]);
          let observed = terminal(await manager.functions.invokeFunction(name, readback), readback);
          assert.equal(observed.ok, true);
          if (
            method === 'renew' &&
            diagnostic.sdkCode === 'DATABASE_TRANSACTION_FAIL' &&
            diagnostic.ledgerStage === 'awaiting-sdk-transaction' &&
            observed.result?.state === 'absent'
          ) {
            assert.deepEqual(observed.result, { state: 'absent' });
            // Retry this exact renewal once; its ledger update and receipt commit atomically.
            try {
              value = terminal(await manager.functions.invokeFunction(name, request), request);
              if (!value.ok)
                diagnostic = {
                  ...diagnostic,
                  ...releaseRegionalDiagnostic(value.error?.diagnostic),
                };
              assert.equal(value.ok, true);
              retryCompleted = true;
            } catch (retryError) {
              diagnostic = { ...diagnostic, ...releaseRegionalDiagnostic(retryError) };
              observed = terminal(await manager.functions.invokeFunction(name, readback), readback);
              assert.equal(observed.ok, true);
            }
          }
          if (!retryCompleted) {
            assert.equal(observed.result.state, 'completed');
            for (const key of ['operationId', 'inputHash', 'method'])
              assert.equal(observed.result[key], request[key]);
            validateResult(request, observed.result.result);
            value = { ok: true, result: observed.result.result };
          }
        }
        assert.equal(value.ok, true);
        state = retryCompleted ? 'completed' : 'readback-confirmed';
      } catch {
        receipt.calls.push({
          operationId: request.operationId,
          method,
          state: 'unconfirmed',
          elapsedMs: Date.now() - started,
          diagnostic,
        });
        return markUnknown(diagnostic);
      }
    }
    const row = {
      operationId: request.operationId,
      method,
      state: value.ok ? state : 'failed',
      elapsedMs: Date.now() - started,
      ...(!value.ok ? { diagnostic } : {}),
    };
    receipt.calls.push(row);
    await persist();
    notify(row);
    if (!value.ok)
      throw Object.assign(Error(value.error?.code ?? 'RELEASE_REGIONAL_FAILED'), {
        code: value.error?.code ?? 'RELEASE_REGIONAL_FAILED',
        ...diagnostic,
        diagnostic,
      });
    return value.result;
  };
  const close = async () => {
    if (closed) return { cleaned: receipt.cleaned, unconfirmed: unknown };
    if (unknown) {
      await persist();
      return { cleaned: false, unconfirmed: true };
    }
    try {
      if (created) {
        own(await manager.functions.getFunctionDetail(name));
        try {
          await manager.functions.deleteFunction(name);
        } catch {}
        let absent = false;
        for (let n = 0; n < 6; n++) {
          if (n) await wait(250 * 2 ** (n - 1));
          if (!(await inventory()).includes(name)) {
            absent = true;
            break;
          }
        }
        assert.ok(absent);
        receipt.cleaned = true;
      }
      closed = true;
      await persist();
      return { cleaned: receipt.cleaned, unconfirmed: false };
    } catch {
      return markUnknown();
    }
  };
  await persist();
  try {
    assert.equal((await inventory()).includes(name), false, 'Release regional name is occupied');
    await build(join(directory, 'function'), codeSha);
    creationStarted = true;
    try {
      await manager.functions.createFunction({
        func: {
          name,
          description,
          runtime: 'Nodejs20.19',
          handler: 'index.main',
          type: 'Event',
          timeout: 45,
          memorySize: 256,
          installDependency: false,
          envVariables: expectedVariables,
        },
        functionPath: join(directory, 'function'),
        force: false,
      });
    } catch {
      assert.ok((await inventory()).includes(name));
      own(await manager.functions.getFunctionDetail(name));
    }
    created = true;
    receipt.created = true;
    let ready = false;
    for (let n = 0; n < 30; n++) {
      const detail = await manager.functions.getFunctionDetail(name);
      own(detail);
      if (detail.Status === 'Active' && detail.AvailableStatus === 'Available') {
        ready = true;
        break;
      }
      assert.ok(!['CreateFailed', 'UpdateFailed'].includes(detail.Status));
      await wait(2000);
    }
    assert.ok(ready);
    assert.equal((await invoke('health', [])).ready, true);
    /** @type {ReturnType<import('./release/state.mjs').createReleaseCoordinator>} */
    const coordinator = Object.freeze({
      targetId: config.targetId,
      beginStep: (input) => invoke('beginStep', [input]),
      recordSubmitted: (input) => invoke('recordSubmitted', [input]),
      confirmStep: (input) => invoke('confirmStep', [input]),
      markUnknown: (input) => invoke('markUnknown', [input]),
      failStep: (input) => invoke('failStep', [input]),
      failRun: (input) => invoke('failRun', [input]),
      commitRun: (input) => invoke('commitRun', [input]),
      resumeReadOnlyAcceptance: (input) => invoke('resumeReadOnlyAcceptance', [input]),
      reconcile: (input) => invoke('reconcile', [input]),
      runStatus: (key) => invoke('runStatus', [key]),
      startRun: (input) => invoke('startRun', [input]),
      acquire: (input) => invoke('acquire', [input]),
      renew: (input) => invoke('renew', [input]),
      releaseFailedSite: (guard, key) => invoke('releaseFailedSite', [guard, key]),
      release: (guard) => invoke('release', [guard]),
      status: (options) => invoke('status', options === undefined ? [] : [options]),
    });
    return {
      coordinator,
      close,
      get unconfirmed() {
        return unknown;
      },
    };
  } catch {
    if (creationStarted) return markUnknown();
    throw Object.assign(Error('Release regional preparation failed before function creation'), {
      code: 'RELEASE_REGIONAL_PREPARATION_FAILED',
    });
  }
}
