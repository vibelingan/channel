import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { buildCatalogRegional } from './catalog-regional-build.mjs';

const purpose = 'catalog-seo-regional-v1';
const description = 'channel-catalog-regional-v1';
const variables = (d) =>
  Object.fromEntries((d.Environment?.Variables ?? []).map((v) => [v.Key, v.Value]));

/** One reviewed run owns one temporary Event function. No HTTP routes or existing functions change. */
export async function createCatalogRegionalClient({
  manager,
  policy,
  runId,
  ownerRunId = runId,
  codeSha,
  runnerRef,
  guard: initialGuard,
  directory,
  requestHash,
  withLease,
  build = buildCatalogRegional,
  wait = pause,
  mask = (token) => console.log(`::add-mask::${token}`),
  onStatus = (event) => console.log(JSON.stringify({ event: 'catalog-regional', ...event })),
}) {
  assert.equal(policy.envId, 'diversity-123-d9grnqfux221323bb');
  assert.equal(policy.region, 'ap-shanghai');
  assert.equal(policy.siteOrigin, 'https://supplychainsai.com');
  assert.match(runId, /^site-([1-9][0-9]{7,19})-([1-9][0-9]*)$/);
  assert.match(codeSha, /^[a-f0-9]{40}$/);
  assert.equal(typeof requestHash, 'function');
  assert.equal(typeof withLease, 'function');
  const target = manager.getManagerConfig();
  assert.equal(target.envId, policy.envId);
  assert.equal(target.region, policy.region);
  const runner = /^github:vibelingan\/channel:([1-9][0-9]{7,19}):attempt-([1-9][0-9]*)$/.exec(
    runnerRef,
  );
  assert.ok(runner, 'Exact current GitHub runner required');
  const operatorId = `${runner[1]}-${runner[2]}`;
  assert.ok(
    (ownerRunId === runId && runId === `site-${operatorId}`) ||
      ownerRunId === `readback-${operatorId}`,
    'Current operator must own the regional execution guard',
  );
  const name = `seo-catalog-region-${operatorId}`;
  const token = randomBytes(32).toString('hex');
  const digest = createHash('sha256').update(token).digest('hex');
  mask(token);
  let guard = initialGuard;
  let unknown = false;
  let creationStarted = false;
  let created = false;
  let closed = false;
  const receipt = {
    schemaVersion: 1,
    purpose,
    runId,
    ownerRunId,
    runnerRef,
    codeSha,
    functionName: name,
    environment: policy.envId,
    websiteWrites: 0,
    businessWrites: 0,
    calls: [],
    created: false,
    cleaned: false,
    unconfirmed: false,
  };
  const persist = async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'result.json'), JSON.stringify(receipt, null, 2), {
      mode: 0o600,
    });
  };
  const validateGuard = (value) => {
    assert.match(value?.targetId ?? '', /^[a-f0-9]{64}$/);
    assert.equal(value.ownerRunId, ownerRunId);
    for (const key of ['fence', 'acquiredVersion'])
      assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0);
    return Object.freeze({
      targetId: value.targetId,
      ownerRunId: value.ownerRunId,
      fence: value.fence,
      acquiredVersion: value.acquiredVersion,
    });
  };
  guard = validateGuard(guard);
  const own = (detail) => {
    const v = variables(detail);
    assert.equal(detail.FunctionName, name);
    assert.equal(detail.Description, description);
    assert.equal(detail.Runtime, 'Nodejs20.19');
    assert.equal(detail.Type, 'Event');
    assert.equal(detail.Handler, 'index.main');
    assert.deepEqual(detail.Triggers ?? [], []);
    assert.equal(v.TCB_ENV, policy.envId);
    assert.equal(v.CATALOG_REGIONAL_RUN_ID, runId);
    assert.equal(v.CATALOG_REGIONAL_TARGET_ID, guard.targetId);
    assert.equal(v.CATALOG_REGIONAL_SITE_ORIGIN, policy.siteOrigin);
    assert.equal(v.CATALOG_REGIONAL_TOKEN_DIGEST, digest);
    assert.equal(v.CATALOG_REGIONAL_RUNNER_REF, runnerRef);
  };
  const inventory = async () => {
    const names = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const rows = await manager.functions.listFunctions(100, offset);
      assert.ok(Array.isArray(rows) && rows.length <= 100);
      for (const row of rows) {
        assert.equal(typeof row.FunctionName, 'string');
        names.push(row.FunctionName);
      }
      if (rows.length < 100) {
        assert.equal(new Set(names).size, names.length);
        return names;
      }
    }
    throw Error('Regional function inventory exceeds bound');
  };
  const terminal = (response, request) => {
    assert.ok(response && typeof response.RequestId === 'string' && response.RequestId);
    assert.equal(typeof response.RetMsg, 'string');
    assert.ok(Buffer.byteLength(response.RetMsg) <= 1024 * 1024);
    assert.ok(response.InvokeFinished === undefined || response.InvokeFinished === 1);
    assert.ok(response.RetCode === undefined || response.RetCode === 0);
    assert.ok(!response.ErrMsg?.trim());
    const value = JSON.parse(response.RetMsg);
    assert.equal(value.purpose, purpose);
    assert.equal(value.runId, runId);
    assert.equal(value.requestId, request.requestId);
    assert.equal(value.action, request.action);
    assert.equal(value.codeSha, codeSha);
    assert.equal(typeof value.ok, 'boolean');
    if (value.ok) validateResult(request, value.result);
    return value;
  };
  const validateResult = (request, result) => {
    assert.ok(result && typeof result === 'object' && !Array.isArray(result));
    if (request.action === 'delivery.begin') {
      assert.ok(result.ticket?.owner?.startsWith(`${runId}:`));
      assert.ok(Number.isSafeInteger(result.ticket.fence) && result.ticket.fence > 0);
      assert.deepEqual(result.ticket.products, request.input.products);
      assert.ok(Array.isArray(result.expectedHeads));
      assert.equal(
        new Set(result.expectedHeads.map((h) => h.productId)).size,
        result.expectedHeads.length,
      );
      for (const head of result.expectedHeads) {
        assert.equal(head.siteOrigin, policy.siteOrigin);
        assert.ok(request.input.products.includes(head.productId));
      }
    }
    if (request.action === 'delivery.end') assert.equal(result.ended, true);
    if (request.action === 'delivery.accept')
      assert.equal(result.accepted, request.input.pages.length);
    if (request.action === 'delivery.check') assert.equal(result.checked, true);
  };
  const invoke = async (action, input = {}) => {
    assert.equal(closed, false, 'Regional client is closed');
    assert.equal(unknown, false, 'Unconfirmed regional operation needs readback');
    const request = {
      schemaVersion: 1,
      token,
      runId,
      targetId: guard.targetId,
      siteOrigin: policy.siteOrigin,
      executorCodeSha: codeSha,
      requestId: randomUUID(),
      guard,
      action,
      input,
    };
    const started = Date.now();
    let value;
    try {
      value = terminal(await manager.functions.invokeFunction(name, request), request);
      // A database commit can succeed while its acknowledgement is lost. A
      // returned generic SDK failure therefore needs the same receipt readback.
      if (!value.ok && value.error?.code === 'REGIONAL_OPERATION_FAILED')
        throw Error('Database completion requires receipt readback');
    } catch {
      const readback = {
        ...request,
        requestId: randomUUID(),
        action: 'operation.get',
        input: { requestId: request.requestId, inputHash: requestHash(request) },
      };
      try {
        const observed = terminal(await manager.functions.invokeFunction(name, readback), readback);
        assert.equal(observed.ok, true);
        assert.equal(observed.result?.state, 'completed');
        assert.equal(observed.result.receipt?.action, action);
        assert.ok(Object.hasOwn(observed.result.receipt, 'result'));
        validateResult(request, observed.result.receipt.result);
        value = { ok: true, result: observed.result.receipt.result };
        receipt.calls.push({ requestId: request.requestId, action, state: 'readback-confirmed' });
      } catch {
        unknown = true;
        receipt.unconfirmed = true;
        receipt.calls.push({ requestId: request.requestId, action, state: 'unconfirmed' });
        await persist();
        throw Object.assign(
          Error('Regional invocation needs readback; keep its function and delivery lock'),
          {
            code: 'CATALOG_REGIONAL_UNCONFIRMED',
          },
        );
      }
    }
    receipt.calls.push({
      requestId: request.requestId,
      action,
      state: value.ok ? 'completed' : 'failed',
      elapsedMs: Date.now() - started,
      ...(!value.ok && value.error?.diagnostic
        ? {
            diagnostic: Object.fromEntries(
              Object.entries(value.error.diagnostic).filter(
                ([key, text]) =>
                  ['sdkCode', 'requestId'].includes(key) &&
                  typeof text === 'string' &&
                  /^[A-Za-z0-9_.-]{1,128}$/.test(text),
              ),
            ),
          }
        : {}),
    });
    await persist();
    onStatus({ action, elapsedMs: Date.now() - started, ok: value.ok });
    if (!value.ok) {
      // The handler returned, so no invocation remains in flight. Its transactional
      // receipt/control still prevents a failed begin from allowing a website write.
      throw Object.assign(Error(value.error?.message ?? 'Regional catalog operation failed'), {
        code: value.error?.code ?? 'CATALOG_REGIONAL_FAILED',
      });
    }
    return value.result;
  };
  // The release owner serializes renewal with the entire invocation/readback.
  // Remote transactions also write the target guard, so a concurrent WAN renewal
  // can repeatedly conflict until the lease expires.
  const call = (action, input = {}) => withLease(() => invoke(action, input));
  const close = async () => {
    if (closed) return;
    if (unknown) {
      await persist();
      return { cleaned: false, unconfirmed: true };
    }
    if (created) {
      own(await manager.functions.getFunctionDetail(name));
      let deletionFailed = false;
      try {
        await manager.functions.deleteFunction(name);
      } catch {
        deletionFailed = true;
      }
      let removed = false;
      for (let n = 0; n < 6; n++) {
        if (n) await wait(250 * 2 ** (n - 1));
        if (!(await inventory()).includes(name)) {
          removed = true;
          break;
        }
      }
      receipt.cleaned = removed;
      await persist();
      assert.ok(
        removed,
        deletionFailed ? 'Regional deletion needs readback' : 'Regional deletion is not confirmed',
      );
    }
    closed = true;
    return { cleaned: receipt.cleaned, unconfirmed: false };
  };
  const capture = (readOnly) => async (config) => {
    for (let round = 0; round < 12_500; round++) {
      const result = readOnly
        ? { ...(await call('capture.read')), ready: true }
        : await call('prepare.step', {
            detailEnabled: config.detailEnabled,
            maxItems: 4,
          });
      if (!result.ready) continue;
      assert.ok(Number.isSafeInteger(result.writes) && result.writes >= 0);
      assert.ok(Array.isArray(result.heads) && result.heads.length <= 50_000);
      const heads = new Map();
      const owners = new Set();
      const expectedWrites = result.writes;
      const delivery = {
        check: () => call('delivery.check', { expectedWrites }),
        primeExpectedHeads(rows) {
          for (const row of rows) {
            assert.equal(row.siteOrigin, policy.siteOrigin);
            assert.ok(
              result.heads.some(
                (head) => head.productId === row.productId && isDeepStrictEqual(head, row),
              ),
              'Acceptance head was not captured',
            );
            heads.set(row.productId, row);
          }
        },
        async begin(products, discovery = false) {
          const value = await call('delivery.begin', { expectedWrites, products, discovery });
          assert.ok(Array.isArray(value.expectedHeads));
          for (const head of value.expectedHeads) heads.set(head.productId, head);
          assert.equal(typeof value.ticket?.owner, 'string');
          owners.add(value.ticket.owner);
          return Object.freeze(value.ticket);
        },
        async end(ticket, outcome) {
          assert.ok(owners.has(ticket.owner), 'Unknown SEO delivery ticket');
          await call('delivery.end', { expectedWrites, ticket, outcome });
          owners.delete(ticket.owner);
        },
        async accept(pages) {
          assert.equal(new Set(pages.map((p) => p.productId)).size, pages.length);
          for (let offset = 0; offset < pages.length; offset += 2) {
            const batch = pages.slice(offset, offset + 2);
            const expectedHeads = batch.map((p) => {
              assert.ok(heads.has(p.productId), 'Missing delivered product version');
              return heads.get(p.productId);
            });
            await call('delivery.accept', { expectedWrites, expectedHeads, pages: batch });
          }
        },
        async retryKnownFailure() {
          assert.equal(owners.size, 0, 'Unknown delivery cannot release its tasks');
          for (const head of heads.values())
            await call('delivery.retry', { expectedWrites, productIds: [head.productId] });
        },
        get trackedProducts() {
          return [...heads.keys()];
        },
      };
      return { writes: expectedWrites, heads: result.heads, delivery };
    }
    throw Error('Regional product changes did not settle within the bounded preparation window');
  };
  try {
    assert.equal((await inventory()).includes(name), false, 'Regional function name is occupied');
    await persist();
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
          envVariables: {
            TCB_ENV: policy.envId,
            CATALOG_REGIONAL_RUN_ID: runId,
            CATALOG_REGIONAL_TARGET_ID: guard.targetId,
            CATALOG_REGIONAL_SITE_ORIGIN: policy.siteOrigin,
            CATALOG_REGIONAL_TOKEN_DIGEST: digest,
            CATALOG_REGIONAL_RUNNER_REF: runnerRef,
          },
        },
        functionPath: join(directory, 'function'),
        force: false,
      });
    } catch {
      // Do not repeat an uncertain create. Only an exact owned readback may continue.
      if (!(await inventory()).includes(name)) throw Error('Regional creation needs readback');
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
      assert.ok(
        !['CreateFailed', 'UpdateFailed'].includes(detail.Status),
        'Regional deployment failed',
      );
      await wait(2000);
    }
    assert.ok(ready, 'Regional deployment is not ready');
    const health = await call('health');
    assert.equal(health.codeSha, codeSha);
    assert.equal(health.runId, runId);
    return {
      get unconfirmed() {
        return unknown;
      },
      setGuard(value) {
        guard = validateGuard(value);
      },
      close,
      async clearAcceptedRegistration({ artifact, acceptedSeal, checkpoint = async () => {} }) {
        const states = ['leased', 'writing', 'needs-readback', 'control'];
        let current = { state: states[0], cursor: null };
        let releasedTasks = 0;
        let controlReleased = false;
        for (let round = 0; round < 30_000; round++) {
          await checkpoint();
          const result = await call('registration.clear', { artifact, acceptedSeal, ...current });
          assert.equal(typeof result.done, 'boolean');
          assert.ok(Number.isSafeInteger(result.releasedTasks) && result.releasedTasks >= 0);
          assert.ok(result.releasedTasks <= 2);
          assert.equal(typeof result.controlReleased, 'boolean');
          assert.ok(!result.controlReleased || current.state === 'control');
          releasedTasks += result.releasedTasks;
          assert.ok(releasedTasks <= 50_000, 'Catalog cleanup exceeds its bound');
          controlReleased ||= result.controlReleased;
          if (result.done) {
            assert.equal(current.state, 'control');
            assert.equal(result.next, null);
            await checkpoint();
            return { releasedTasks, controlReleased };
          }
          const next = result.next;
          assert.ok(next && states.includes(next.state), 'Missing cleanup continuation');
          const previousIndex = states.indexOf(current.state);
          const nextIndex = states.indexOf(next.state);
          if (nextIndex === previousIndex) {
            assert.notEqual(next.state, 'control');
            assert.match(next.cursor ?? '', /^[a-f0-9]{64}$/);
            assert.ok(current.cursor === null || next.cursor > current.cursor);
            assert.notEqual(next.cursor, current.cursor);
          } else {
            assert.equal(nextIndex, previousIndex + 1);
            assert.equal(next.cursor, null);
          }
          current = { state: next.state, cursor: next.cursor };
        }
        throw Error('Accepted catalog cleanup did not finish within its bound');
      },
      async seed(productIds, config) {
        const ids = [...new Set(productIds)];
        assert.ok(ids.length <= 50_000);
        const totals = { queued: 0, preserved: 0, tracked: 0, upgraded: 0 };
        for (let offset = 0; offset < ids.length; offset += 16) {
          const result = await call('seed', {
            productIds: ids.slice(offset, offset + 16),
            detailEnabled: config.detailEnabled,
          });
          for (const key of Object.keys(totals)) {
            assert.ok(Number.isSafeInteger(result[key]) && result[key] >= 0);
            totals[key] += result[key];
          }
        }
        return totals;
      },
      prepare: capture(false),
      capture: capture(true),
    };
  } catch (error) {
    if (creationStarted && !created) {
      unknown = true;
      receipt.unconfirmed = true;
      await persist();
      throw Object.assign(Error('Regional creation needs readback; keep its delivery lock'), {
        code: 'CATALOG_REGIONAL_UNCONFIRMED',
      });
    }
    await close();
    throw error;
  }
}
