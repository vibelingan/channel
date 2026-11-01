import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import { CatalogPublicHeadSchema, catalogPublicRecordId } from './catalog-public-changes.ts';
import { type CatalogSeoDatabase, createCatalogSeoStore } from './catalog-seo-cloud.ts';
import type { CatalogSeoStore } from './catalog-seo-consumer.ts';
import { catalogSeoControlId, idleCatalogSeoControl } from './catalog-seo-control.ts';
import { createCatalogSeoDeliveryStateless } from './catalog-seo-delivery.ts';
import {
  catalogRegionalReceiptId,
  catalogRegionalRequestHash,
  createCatalogRegionalHandler,
} from './catalog-seo-regional.ts';
import type { CatalogRegionalConfig, CatalogRegionalDelivery } from './catalog-seo-regional.ts';
import { createCatalogSeoRequest } from './catalog-seo-requests.ts';

const token = 'a'.repeat(64);
const now = Date.parse('2026-11-01T00:00:00.000Z');
const config: CatalogRegionalConfig = {
  envId: 'diversity-123-d9grnqfux221323bb',
  runId: 'site-41300590230-1',
  targetId: 'b'.repeat(64),
  siteOrigin: 'https://supplychainsai.com',
  codeSha: 'c'.repeat(40),
  tokenDigest: createHash('sha256').update(token).digest('hex'),
  runnerRef: 'github:vibelingan/channel:41300590230:attempt-1',
};
const guard = { targetId: config.targetId, ownerRunId: config.runId, fence: 7, acquiredVersion: 8 };
const request = (action: string, input = {}, requestId = 'request-1') => ({
  schemaVersion: 1,
  token,
  runId: config.runId,
  targetId: config.targetId,
  siteOrigin: config.siteOrigin,
  executorCodeSha: config.codeSha,
  requestId,
  guard,
  action,
  input,
});
const acceptedArtifact = {
  repository: 'vibelingan/channel',
  workflowPath: '.github/workflows/seo-static-canary.yml',
  runId: '41300590230',
  artifactId: '12345',
  manifestSha256: 'e'.repeat(64),
  expiresAt: '2026-12-01T00:00:00.000Z',
};
const acceptedSeal = {
  schemaVersion: 1,
  activationId: 'cf576f0a-e3ca-40a5-9b1b-3a095a5e2594',
  releaseId: config.runId,
  codeSha: config.codeSha,
  artifact: acceptedArtifact,
  target: { envId: config.envId, siteOrigin: config.siteOrigin },
  scope: { kind: 'site' },
};
const runKey = createHash('sha256')
  .update(JSON.stringify({ runId: config.runId, targetId: config.targetId }))
  .digest('hex');
const clearInput = (state = 'leased', cursor: string | null = null) => ({
  artifact: acceptedArtifact,
  acceptedSeal,
  state,
  cursor,
});

function acceptedRows(
  put: (collection: string, row: CollectionDoc) => void,
  target: CollectionDoc,
) {
  put('siteReleaseTargets', {
    ...target,
    currentRunId: null,
    dirtyRunId: null,
    unresolvedOperation: null,
  });
  const pointer = {
    sourceRunId: config.runId,
    activationId: acceptedSeal.activationId,
    compositionHash: '7'.repeat(64),
  };
  put('siteReleaseScopes', {
    _id: `${config.targetId}-site`,
    schemaVersion: 1,
    targetId: config.targetId,
    scopeKey: 'site',
    scope: { kind: 'site' },
    version: 1,
    active: pointer,
    baseline: pointer,
  });
  put('siteReleaseRuns', {
    _id: runKey,
    schemaVersion: 1,
    runId: config.runId,
    targetId: config.targetId,
    scopeKey: 'site',
    state: 'SUCCEEDED',
    composition: { static: { artifact: acceptedArtifact } },
    accepted: {
      sourceRunId: config.runId,
      activationId: acceptedSeal.activationId,
      seals: { static: acceptedSeal },
    },
  });
}

function registrationTask(
  put: (collection: string, row: CollectionDoc) => void,
  productId: string,
  runId = config.runId,
) {
  const key = catalogPublicRecordId(config.siteOrigin, productId);
  put('catalogPublicHeads', {
    _id: key,
    schemaVersion: 1,
    siteOrigin: config.siteOrigin,
    productId,
    sequence: 2,
    visible: true,
    semanticHash: 'a'.repeat(64),
    detailRevision: null,
    changedAt: new Date(now).toISOString(),
    latestEventId: 'b'.repeat(64),
  });
  put('catalogSeoTasks', {
    _id: key,
    schemaVersion: 1,
    siteOrigin: config.siteOrigin,
    productId,
    requestedSequence: 2,
    acceptedSequence: 1,
    state: 'writing',
    attempts: 2,
    lease: { runId, sequence: 2, until: new Date(now + 30000).toISOString() },
  });
  return key;
}

function registrationControl(products: readonly string[]) {
  return {
    ...idleCatalogSeoControl(config.siteOrigin, new Date(now).toISOString()),
    state: 'writing',
    owner: `${config.runId}:registration`,
    until: new Date(now + 30000).toISOString(),
    fence: 3,
    writes: 7,
    products: [...products],
    families: [],
    discovery: false,
  };
}

test('bounded accepted registration cleanup visits all owned tasks, preserves others and replays its atomic receipt', async () => {
  const x = fixture();
  acceptedRows(x.put, x.target);
  const owned = Array.from({ length: 7 }, (_, index) => `owned-${index}`);
  for (const productId of owned) registrationTask(x.put, productId);
  const other = Array.from({ length: 107 }, (_, index) => `foreign-${index}`);
  for (const productId of other) registrationTask(x.put, productId, 'site-12345-2');
  x.put('catalogSeoControl', registrationControl(owned.slice(0, 2)));
  const pending = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'new-request', previouslyPublic: true },
    new Date(now).toISOString(),
  );
  x.put('catalogSeoRequests', pending);
  const untouched = other.map((productId) =>
    x.read('catalogSeoTasks', catalogPublicRecordId(config.siteOrigin, productId)),
  );
  let input = clearInput();
  let total = 0;
  let finalized = 0;
  let replayInput: ReturnType<typeof request> | undefined;
  let replayResult: unknown;
  let done = false;
  for (let index = 0; index < 30; index++) {
    const command = request('registration.clear', input, `clear-${index}`);
    const response = await x.handler(command);
    assert.equal(response.ok, true, JSON.stringify(response.error));
    const result = response.result;
    assert(result && typeof result.releasedTasks === 'number' && result.releasedTasks <= 2);
    total += result.releasedTasks;
    finalized += result.controlReleased ? 1 : 0;
    if (result.releasedTasks && !replayInput) {
      replayInput = command;
      replayResult = structuredClone(result);
    }
    if (result.done) {
      done = true;
      assert.equal(result.next, null);
      break;
    }
    const next = result.next;
    assert(next && typeof next === 'object' && !Array.isArray(next));
    input = clearInput(String(Reflect.get(next, 'state')), Reflect.get(next, 'cursor'));
  }
  assert.equal(done, true);
  assert.equal(total, 7);
  assert.equal(finalized, 1);
  const control = x.read('catalogSeoControl', catalogSeoControlId(config.siteOrigin));
  assert.equal(control?.state, 'idle');
  assert.equal(control?.writes, 7);
  assert.equal(control?.fence, 4);
  for (const productId of owned) {
    const task = x.read('catalogSeoTasks', catalogPublicRecordId(config.siteOrigin, productId));
    assert.equal(task?.state, 'pending');
    assert.equal(task?.lease, null);
    assert.equal(task?.acceptedSequence, 1);
    assert.equal(task?.attempts, 2);
  }
  assert.deepEqual(
    other.map((productId) =>
      x.read('catalogSeoTasks', catalogPublicRecordId(config.siteOrigin, productId)),
    ),
    untouched,
  );
  assert.deepEqual(x.read('catalogSeoRequests', pending._id), pending);
  assert(replayInput);
  const before = x.written.length;
  assert.deepEqual((await x.handler(replayInput)).result, replayResult);
  assert.equal(x.written.length, before);
  assert.ok(
    x.written.every((collection) =>
      ['catalogSeoTasks', 'catalogSeoControl', 'catalogSeoBuilders', 'siteReleaseTargets'].includes(
        collection,
      ),
    ),
  );
});

test('accepted cleanup binds the old site run to the new readback guard, not to caller-supplied SUCCEEDED state', async () => {
  const x = fixture();
  const readbackConfig = { ...config, runnerRef: 'github:vibelingan/channel:99999999:attempt-2' };
  const readbackGuard = { ...guard, ownerRunId: 'readback-99999999-2' };
  acceptedRows(x.put, {
    ...x.target,
    lease: { ...readbackGuard, runnerRef: readbackConfig.runnerRef, expiresAt: now + 120000 },
  });
  const handler = createCatalogRegionalHandler(readbackConfig, {
    createStore: () => x.store,
    createDelivery: createCatalogSeoDeliveryStateless,
    now: () => now,
  });
  assert.equal(
    (await handler({ ...request('registration.clear', clearInput()), guard: readbackGuard })).ok,
    true,
  );
  for (const changed of [
    { artifact: { ...acceptedArtifact, artifactId: '9999' } },
    { acceptedSeal: { ...acceptedSeal, codeSha: '0'.repeat(40) } },
  ]) {
    const response = await handler({
      ...request(
        'registration.clear',
        { ...clearInput(), ...changed },
        `reject-${Object.keys(changed)[0]}`,
      ),
      guard: readbackGuard,
    });
    assert.equal(response.error?.code, 'REGIONAL_REGISTRATION_SOURCE_CHANGED');
  }
  x.put('siteReleaseRuns', { _id: runKey, state: 'FAILED', runId: config.runId });
  assert.equal(
    (
      await handler({
        ...request('registration.clear', clearInput(), 'failed-real-run'),
        guard: readbackGuard,
      })
    ).error?.code,
    'REGIONAL_REGISTRATION_SOURCE_CHANGED',
  );
});

test('cleanup rejects other owners, unknown hosting, and source changes inside its real transaction', async () => {
  for (const kind of ['owner', 'discovery', 'dirty', 'transaction-baseline']) {
    const x = fixture();
    acceptedRows(x.put, x.target);
    const key = registrationTask(x.put, 'p');
    const control = registrationControl(['p']);
    x.put('catalogSeoControl', {
      ...control,
      ...(kind === 'owner' ? { owner: 'site-other:metadata' } : {}),
      ...(kind === 'discovery' ? { discovery: true } : {}),
    });
    if (kind === 'dirty')
      x.put('siteReleaseTargets', {
        ...x.target,
        currentRunId: null,
        dirtyRunId: 'unknown-site',
        unresolvedOperation: null,
      });
    if (kind === 'transaction-baseline') {
      const transaction = x.store.transaction;
      x.store.transaction = async (operation) => {
        const scope = x.read('siteReleaseScopes', `${config.targetId}-site`);
        assert(scope);
        x.put('siteReleaseScopes', {
          ...scope,
          baseline: { sourceRunId: 'new-site', activationId: 'a'.repeat(64) },
        });
        return transaction(operation);
      };
    }
    const before = x.read('catalogSeoTasks', key);
    const result = await x.handler(request('registration.clear', clearInput('writing')));
    assert.equal(result.ok, false);
    assert.deepEqual(x.read('catalogSeoTasks', key), before);
    assert.equal(
      x.read('catalogSeoBuilders', catalogRegionalReceiptId(config.runId, 'request-1')),
      null,
    );
  }
});

test('the installed SDK rolls back task cleanup when its same-transaction receipt is not acknowledged', async (t) => {
  const x = articleSdkFixture(t);
  const native: unknown = x.db;
  assert(native && typeof native === 'object');
  assert.equal(typeof Reflect.get(native, 'runTransaction'), 'function');
  const db = native as CatalogSeoDatabase;
  const put = (collection: string, row: CollectionDoc) => x.put(collection, row._id, row);
  const target = {
    _id: config.targetId,
    schemaVersion: 1,
    targetId: config.targetId,
    target: { envId: config.envId, siteOrigin: config.siteOrigin },
    lease: { ...guard, runnerRef: config.runnerRef, expiresAt: now + 120000 },
  };
  acceptedRows(put, target);
  const key = registrationTask(put, 'real-sdk');
  put('catalogSeoControl', registrationControl(['real-sdk']));
  const store = createCatalogSeoStore(db);
  const handler = createCatalogRegionalHandler(config, {
    createStore: () => store,
    createDelivery: createCatalogSeoDeliveryStateless,
    now: () => now,
  });
  x.control.zeroWriteCollection = 'catalogSeoBuilders';
  const command = request('registration.clear', clearInput('writing'));
  assert.equal((await handler(command)).ok, false);
  assert.equal(x.rows.get(`catalogSeoTasks/${key}`)?.state, 'writing');
  assert.equal(
    x.rows.has(`catalogSeoBuilders/${catalogRegionalReceiptId(config.runId, command.requestId)}`),
    false,
  );
  Reflect.deleteProperty(x.control, 'zeroWriteCollection');
  const renewedUntil = now + 600000;
  x.control.beforeCommit = () => {
    x.control.beforeCommit = undefined;
    const current = x.rows.get(`siteReleaseTargets/${config.targetId}`);
    assert(current);
    const lease = current.lease;
    assert(lease && typeof lease === 'object' && !Array.isArray(lease));
    x.put('siteReleaseTargets', config.targetId, {
      ...current,
      lease: { ...lease, expiresAt: renewedUntil },
    });
  };
  const response = await handler(command);
  assert.equal(response.ok, true);
  assert.equal(response.result?.releasedTasks, 1);
  const observed = await handler(
    request(
      'operation.get',
      { requestId: command.requestId, inputHash: catalogRegionalRequestHash(command) },
      'lookup-clear',
    ),
  );
  assert.deepEqual(observed.result, {
    state: 'completed',
    receipt: { action: 'registration.clear', result: response.result },
  });
  assert.equal(x.rows.get(`catalogSeoTasks/${key}`)?.lease, null);
  assert.equal(
    Reflect.get(Object(x.rows.get(`siteReleaseTargets/${config.targetId}`)?.lease), 'expiresAt'),
    renewedUntil,
  );
  assert.ok(x.calls.filter((call) => call.api === 'database.startTransaction').length >= 3);
});

const rendererProof = {
  codeSha: 'd'.repeat(40),
  manifestSha256: '6'.repeat(64),
  archiveSha256: '7'.repeat(64),
  archiveFileId: `cloud://${config.envId}.private/catalog-renderer/approved.tar.gz`,
  inputSchema: 1,
};
const activeInput = () => ({
  artifact: acceptedArtifact,
  acceptedSeal,
  renderer: rendererProof,
  executorRef: 'feat/seo-foundation',
  expectedWrites: 0,
});
const activeData = () => ({
  codeSha: rendererProof.codeSha,
  manifestSha256: rendererProof.manifestSha256,
  executorSha: config.codeSha,
  executorRef: 'feat/seo-foundation',
  acceptedRunId: config.runId,
  catalogTracked: true,
});
function approveRenderer(put: (collection: string, row: CollectionDoc) => void) {
  put('catalogSeoBuilders', {
    _id: rendererProof.codeSha,
    schemaVersion: 1,
    codeSha: rendererProof.codeSha,
    manifestSha256: rendererProof.manifestSha256,
    archiveSha256: rendererProof.archiveSha256,
    archiveObject: { fileID: rendererProof.archiveFileId },
    inputSchema: 1,
  });
}
function prepareActiveFixture() {
  const x = fixture();
  acceptedRows(x.put, x.target);
  const run = x.read('siteReleaseRuns', runKey);
  assert(run);
  x.put('siteReleaseRuns', { ...run, baseScopeVersion: 1 });
  approveRenderer(x.put);
  return x;
}

test('regional activation derives a fixed active record from approved renderer and accepted site', async () => {
  const x = prepareActiveFixture();
  const business = { _id: 'customer', published: true, name: 'Keep current product', extra: 42 };
  const article = { _id: 'article', title: 'New article remains', revision: 12 };
  x.put('products', business);
  x.put('articles', article);
  const command = request('registration.activate', activeInput());
  const result = await x.handler(command);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, { registered: true, active: activeData() });
  assert.deepEqual(x.read('catalogSeoBuilders', 'active'), { _id: 'active', ...activeData() });
  assert.deepEqual(x.read('products', business._id), business);
  assert.deepEqual(x.read('articles', article._id), article);
  assert.ok(
    x.written.every((collection) =>
      ['catalogSeoBuilders', 'siteReleaseTargets'].includes(collection),
    ),
  );
  const written = x.written.length;
  assert.deepEqual((await x.handler(command)).result, result.result);
  assert.equal(x.written.length, written);
  const replay = await x.handler(
    request(
      'operation.get',
      {
        requestId: command.requestId,
        inputHash: catalogRegionalRequestHash(command),
      },
      'activation-readback',
    ),
  );
  assert.deepEqual(replay.result, {
    state: 'completed',
    receipt: { action: 'registration.activate', result: result.result },
  });
});

test('activation rejects unapproved renderer identities and arbitrary remote write fields', async () => {
  for (const changed of [
    { renderer: { ...rendererProof, manifestSha256: '0'.repeat(64) } },
    { renderer: { ...rendererProof, archiveSha256: '0'.repeat(64) } },
    { renderer: { ...rendererProof, archiveFileId: `cloud://${config.envId}.private/other` } },
    { data: { _id: 'customer', catalogTracked: true } },
    { collection: 'products' },
    { executorRef: 'main' },
  ]) {
    const x = prepareActiveFixture();
    const result = await x.handler(
      request('registration.activate', { ...activeInput(), ...changed }),
    );
    assert.equal(result.ok, false);
    assert.equal(
      result.error?.code,
      'renderer' in changed ? 'REGIONAL_RENDERER_NOT_APPROVED' : 'REGIONAL_INVALID_REQUEST',
    );
    assert.equal(x.read('catalogSeoBuilders', 'active'), null);
  }
});

test('older site and newer active pointers cannot be overwritten by a stale registration', async () => {
  for (const changed of ['baseline', 'newer-active', 'same-run-different-renderer']) {
    const x = prepareActiveFixture();
    const newerRunId = 'site-99999999-1';
    const newerKey = createHash('sha256')
      .update(JSON.stringify({ runId: newerRunId, targetId: config.targetId }))
      .digest('hex');
    const next = { ...activeData(), acceptedRunId: newerRunId };
    if (changed === 'baseline') {
      const scope = x.read('siteReleaseScopes', `${config.targetId}-site`);
      assert(scope);
      x.put('siteReleaseScopes', {
        ...scope,
        active: { sourceRunId: newerRunId },
        baseline: { sourceRunId: newerRunId },
      });
    } else if (changed === 'newer-active') {
      x.put('siteReleaseRuns', {
        _id: newerKey,
        schemaVersion: 1,
        targetId: config.targetId,
        runId: newerRunId,
        scopeKey: 'site',
        state: 'SUCCEEDED',
        baseScopeVersion: 2,
        accepted: { sourceRunId: newerRunId },
      });
    } else {
      next.acceptedRunId = config.runId;
      next.codeSha = '0'.repeat(40);
    }
    x.put('catalogSeoBuilders', { _id: 'active', ...next });
    const result = await x.handler(request('registration.activate', activeInput()));
    assert.equal(result.ok, false);
    assert.equal(
      result.error?.code,
      changed === 'baseline'
        ? 'REGIONAL_REGISTRATION_SOURCE_CHANGED'
        : 'REGIONAL_ACTIVATION_CHANGED',
    );
    assert.deepEqual(x.read('catalogSeoBuilders', 'active'), { _id: 'active', ...next });
  }
});

test('an older accepted active pointer may advance to the current accepted program', async () => {
  const x = prepareActiveFixture();
  const previousRunId = 'site-11111111-1';
  const previousKey = createHash('sha256')
    .update(JSON.stringify({ runId: previousRunId, targetId: config.targetId }))
    .digest('hex');
  x.put('siteReleaseRuns', {
    _id: previousKey,
    schemaVersion: 1,
    targetId: config.targetId,
    runId: previousRunId,
    scopeKey: 'site',
    state: 'SUCCEEDED',
    baseScopeVersion: 0,
    accepted: { sourceRunId: previousRunId },
  });
  x.put('catalogSeoBuilders', { _id: 'active', ...activeData(), acceptedRunId: previousRunId });
  assert.equal((await x.handler(request('registration.activate', activeInput()))).ok, true);
  assert.equal(x.read('catalogSeoBuilders', 'active')?.acceptedRunId, config.runId);
});

test('a changed registration guard or current product revision prevents active writes', async () => {
  for (const changed of ['fence', 'writes', 'control']) {
    const x = prepareActiveFixture();
    if (changed === 'fence')
      x.put('siteReleaseTargets', {
        ...x.target,
        currentRunId: null,
        dirtyRunId: null,
        unresolvedOperation: null,
        lease: {
          ...guard,
          fence: guard.fence + 1,
          runnerRef: config.runnerRef,
          expiresAt: now + 120000,
        },
      });
    else
      x.put('catalogSeoControl', {
        ...idleCatalogSeoControl(config.siteOrigin, new Date(now).toISOString()),
        ...(changed === 'writes' ? { writes: 1 } : registrationControl([])),
      });
    const response = await x.handler(request('registration.activate', activeInput()));
    assert.equal(response.ok, false);
    assert.equal(
      response.error?.code,
      changed === 'fence' ? 'REGIONAL_LEASE_CHANGED' : 'REGIONAL_NOT_SETTLED',
    );
    assert.equal(x.read('catalogSeoBuilders', 'active'), null);
  }
});

test('activation rejects changed accepted artifact, seal and malformed real activation identities', async () => {
  for (const changed of ['artifact', 'seal', 'activation-id']) {
    const x = prepareActiveFixture();
    const input = activeInput();
    if (changed === 'artifact') input.artifact = { ...input.artifact, artifactId: '9999' };
    else if (changed === 'seal')
      input.acceptedSeal = { ...input.acceptedSeal, codeSha: '0'.repeat(40) };
    else {
      const run = x.read('siteReleaseRuns', runKey);
      assert(run);
      x.put('siteReleaseRuns', {
        ...run,
        accepted: {
          sourceRunId: config.runId,
          activationId: 'invalid id with spaces',
          seals: { static: acceptedSeal },
        },
      });
    }
    const result = await x.handler(request('registration.activate', input));
    assert.equal(result.error?.code, 'REGIONAL_REGISTRATION_SOURCE_CHANGED');
    assert.equal(x.read('catalogSeoBuilders', 'active'), null);
  }
});

test('lease expiry during activation reads rolls back active and the atomic receipt', async () => {
  const x = prepareActiveFixture();
  const transaction = x.store.transaction;
  x.store.transaction = (operation) =>
    transaction((tx) =>
      operation({
        ...tx,
        get: async (collection, key) => {
          const result = await tx.get(collection, key);
          if (collection === 'catalogSeoBuilders' && key === rendererProof.codeSha)
            x.advance(120001);
          return result;
        },
      }),
    );
  const command = request('registration.activate', activeInput());
  const result = await x.handler(command);
  assert.equal(result.error?.code, 'REGIONAL_LEASE_CHANGED');
  assert.equal(x.read('catalogSeoBuilders', 'active'), null);
  assert.equal(
    x.read('catalogSeoBuilders', catalogRegionalReceiptId(config.runId, command.requestId)),
    null,
  );
});

test('failed activation receipt storage cannot leave an active pointer without its receipt', async () => {
  const x = prepareActiveFixture();
  const command = request('registration.activate', activeInput());
  const key = catalogRegionalReceiptId(config.runId, command.requestId);
  x.failReceipt(key);
  assert.equal((await x.handler(command)).ok, false);
  assert.equal(x.read('catalogSeoBuilders', 'active'), null);
  assert.equal(x.read('catalogSeoBuilders', key), null);
  x.failReceipt('');
  assert.equal((await x.handler(command)).ok, true);
});

test('activation receipt cannot claim current authority after active or site ownership changes', async () => {
  for (const changed of ['active', 'baseline', 'fence', 'expiry']) {
    const x = prepareActiveFixture();
    const command = request('registration.activate', activeInput());
    assert.equal((await x.handler(command)).ok, true);
    if (changed === 'active')
      x.put('catalogSeoBuilders', { _id: 'active', ...activeData(), executorSha: '0'.repeat(40) });
    if (changed === 'baseline') {
      const scope = x.read('siteReleaseScopes', `${config.targetId}-site`);
      assert(scope);
      x.put('siteReleaseScopes', { ...scope, baseline: { sourceRunId: 'site-99999999-1' } });
    }
    if (changed === 'fence')
      x.put('siteReleaseTargets', {
        ...x.target,
        lease: { ...guard, fence: 99, runnerRef: config.runnerRef, expiresAt: now + 120000 },
      });
    if (changed === 'expiry') x.advance(120001);
    const written = x.written.length;
    const reply = await x.handler(
      request(
        'operation.get',
        { requestId: command.requestId, inputHash: catalogRegionalRequestHash(command) },
        'read-activation',
      ),
    );
    assert.equal(reply.ok, false);
    assert.equal(x.written.length, written);
    assert.equal((await x.handler(command)).ok, false);
    assert.equal(x.written.length, written);
  }
});

test('the same accepted renderer can upgrade an untracked pointer without erasing its program identity', async () => {
  const x = prepareActiveFixture();
  x.put('catalogSeoBuilders', {
    _id: 'active',
    ...activeData(),
    catalogTracked: false,
    executorSha: '0'.repeat(40),
  });
  assert.equal((await x.handler(request('registration.activate', activeInput()))).ok, true);
  assert.deepEqual(x.read('catalogSeoBuilders', 'active'), { _id: 'active', ...activeData() });
});

test('capture.read is a fresh zero-write read and refuses pending work without consuming it', async () => {
  const x = fixture();
  const first = await x.handler(request('capture.read'));
  assert.equal(first.ok, true);
  assert.deepEqual(first.result, { writes: 0, heads: [] });
  assert.deepEqual(x.written, []);
  const pending = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'new', previouslyPublic: true },
    new Date(now).toISOString(),
  );
  x.put('catalogSeoRequests', pending);
  const result = await x.handler(request('capture.read', {}, 'read-with-pending'));
  assert.equal(result.error?.code, 'REGIONAL_NOT_SETTLED');
  assert.deepEqual(x.read('catalogSeoRequests', pending._id), pending);
  assert.deepEqual(x.written, []);
});
function fixture() {
  let rows = new Map<string, CollectionDoc>();
  let created = 0;
  let elapsed = 0;
  let active = 0;
  let peak = 0;
  let fail: string | undefined;
  let failedReceipt: string | undefined;
  const written: string[] = [];
  const target: CollectionDoc = {
    _id: config.targetId,
    schemaVersion: 1,
    targetId: config.targetId,
    target: {
      repository: 'vibelingan/channel',
      envId: config.envId,
      siteOrigin: config.siteOrigin,
    },
    lease: { ...guard, runnerRef: config.runnerRef, expiresAt: now + 120_000 },
    retainedField: 'keep-me',
  };
  rows.set(`siteReleaseTargets/${config.targetId}`, target);
  const store: CatalogSeoStore = {
    get: async (collection, key) => structuredClone(rows.get(`${collection}/${key}`) ?? null),
    list: async (collection, filter, cursor, limit) =>
      [...rows.entries()]
        .filter(
          ([key, row]) =>
            key.startsWith(`${collection}/`) &&
            row._id > (cursor ?? '') &&
            Object.entries(filter).every(([key, value]) => row[key] === value),
        )
        .map(([, row]) => structuredClone(row))
        .sort((a, b) => (a._id < b._id ? -1 : 1))
        .slice(0, limit),
    transaction: async (operation) => {
      active++;
      peak = Math.max(peak, active);
      const draft = structuredClone(rows);
      let writing = false;
      try {
        const value = await operation({
          get: async (collection, key) => {
            assert.equal(writing, false, 'All reads precede writes');
            await Promise.resolve();
            return structuredClone(draft.get(`${collection}/${key}`) ?? null);
          },
          set: async (collection, row) => {
            writing = true;
            if (collection === fail || row._id === failedReceipt)
              throw Error('secret-signature-and-password');
            written.push(collection);
            draft.set(`${collection}/${row._id}`, structuredClone(row));
          },
        });
        rows = draft;
        return value;
      } finally {
        active--;
      }
    },
  };
  const createDelivery = (db: CatalogSeoStore): CatalogRegionalDelivery => ({
    check: async () => {},
    begin: (products) =>
      db.transaction(async (tx) => {
        const controlId = catalogSeoControlId(config.siteOrigin);
        const c =
          (await tx.get('catalogSeoControl', controlId)) ??
          idleCatalogSeoControl(config.siteOrigin, new Date(now).toISOString());
        const ticket = { owner: `${config.runId}:ticket`, fence: 1, products: [...products] };
        await tx.set('catalogSeoControl', { ...c, ...ticket, state: 'writing' });
        return { ticket, expectedHeads: [] };
      }),
    end: (_ticket, outcome) =>
      db.transaction(async (tx) => {
        const c = await tx.get('catalogSeoControl', catalogSeoControlId(config.siteOrigin));
        assert(c);
        await tx.set(
          'catalogSeoControl',
          outcome === 'unknown'
            ? { ...c, state: 'needs-readback' }
            : idleCatalogSeoControl(config.siteOrigin, new Date(now).toISOString()),
        );
      }),
    accept: (pages) =>
      db.transaction(async (tx) => {
        for (const page of pages) await tx.get('catalogSeoPages', page.productId);
        for (const page of pages) await tx.set('catalogSeoPages', { _id: page.productId, ...page });
      }),
    retryKnownFailure: () => db.transaction(async () => {}),
  });
  const makeHandler = (
    delivery: Parameters<typeof createCatalogRegionalHandler>[1]['createDelivery'] = createDelivery,
  ) =>
    createCatalogRegionalHandler(config, {
      createStore: () => {
        created++;
        return store;
      },
      createDelivery: delivery,
      now: () => now + elapsed,
    });
  const handler = makeHandler();
  return {
    handler,
    store,
    written,
    target,
    makeHandler,
    created: () => created,
    peak: () => peak,
    put: (collection: string, row: CollectionDoc) =>
      rows.set(`${collection}/${row._id}`, structuredClone(row)),
    read: (collection: string, key: string) =>
      structuredClone(rows.get(`${collection}/${key}`) ?? null),
    fail: (collection: string) => {
      fail = collection;
    },
    failReceipt: (key: string) => {
      failedReceipt = key;
    },
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

test('health and denied calls initialize no database, and never echo secrets', async () => {
  const x = fixture();
  const health = await x.handler(request('health'));
  assert.equal(health.ok, true);
  assert.equal(health.codeSha, config.codeSha);
  for (const bad of [
    { ...request('seed', { productIds: ['p'], detailEnabled: true }), token: '0'.repeat(64) },
    { ...request('health'), runId: 'site-99-1' },
    { ...request('health'), executorCodeSha: '0'.repeat(40) },
    { ...request('health'), siteOrigin: 'https://other.example' },
    { ...request('health'), targetId: '0'.repeat(64) },
    { ...request('health'), extra: 'denied' },
    request('seed', { productIds: ['p'], detailEnabled: true, collection: 'products' }),
    request('seed', {
      productIds: Array.from({ length: 17 }, (_, i) => `${i}`),
      detailEnabled: true,
    }),
  ]) {
    const result = await x.handler(bad);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
  assert.equal(x.created(), 0);
});

test('seed transactions serialize, preserve the release target, and replay without duplicate requests', async () => {
  const x = fixture();
  const input = request('seed', { productIds: ['p1', 'p2', 'p3', 'p4'], detailEnabled: true });
  const first = await x.handler(input);
  assert.equal(first.ok, true);
  assert.deepEqual(first.result, { queued: 4, preserved: 0, tracked: 0, upgraded: 0 });
  assert.equal(x.peak(), 1);
  assert.deepEqual(x.read('siteReleaseTargets', config.targetId), x.target);
  assert.ok(x.written.includes('siteReleaseTargets'));
  assert.ok(
    x.written.every((name) =>
      ['siteReleaseTargets', 'catalogSeoRequests', 'catalogSeoBuilders'].includes(name),
    ),
  );
  const before = x.written.length;
  assert.deepEqual(await x.handler(input), first);
  assert.equal(x.written.length, before);
});

test('same request id with different input is rejected', async () => {
  const x = fixture();
  assert.equal(
    (await x.handler(request('seed', { productIds: ['p1'], detailEnabled: true }))).ok,
    true,
  );
  const changed = await x.handler(request('seed', { productIds: ['p2'], detailEnabled: true }));
  assert.equal(changed.ok, false);
  assert.equal(changed.error?.code, 'REGIONAL_OPERATION_MISMATCH');
});

test('expired, changed owner, fence, runner, and acquired version reject before SEO writes', async () => {
  for (const patch of [
    { expiresAt: now },
    { ownerRunId: 'site-999-1' },
    { fence: 8 },
    { runnerRef: 'github:other/repo:1:attempt-1' },
    { acquiredVersion: 9 },
  ]) {
    const x = fixture();
    x.put('siteReleaseTargets', {
      ...x.target,
      lease: { ...(x.target.lease as object), ...patch },
    });
    const result = await x.handler(request('seed', { productIds: ['p1'], detailEnabled: true }));
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'REGIONAL_LEASE_CHANGED');
    assert.deepEqual(x.written, []);
  }
});

test('begin receipt is atomic, can be read after a lost reply, and expires when its ticket ends', async () => {
  const x = fixture();
  const input = request('delivery.begin', { expectedWrites: 0, products: [], discovery: true });
  const first = await x.handler(input);
  assert.equal(first.ok, true);
  const readback = request(
    'operation.get',
    { requestId: input.requestId, inputHash: catalogRegionalRequestHash(input) },
    'readback',
  );
  const proof = await x.handler(readback);
  assert.equal(proof.ok, true);
  assert.deepEqual(proof.result, {
    state: 'completed',
    receipt: { action: 'delivery.begin', result: first.result },
  });
  assert.deepEqual(await x.handler(input), first);
  const end = await x.handler(
    request(
      'delivery.end',
      { expectedWrites: 0, ticket: first.result?.ticket, outcome: 'verified' },
      'end',
    ),
  );
  assert.equal(end.ok, true);
  assert.equal((await x.handler(input)).error?.code, 'REGIONAL_TICKET_ENDED');
  assert.equal((await x.handler(readback)).error?.code, 'REGIONAL_TICKET_ENDED');
});

test('failed receipt write rolls back the control mutation and does not reveal the SDK exception', async () => {
  const x = fixture();
  x.fail('catalogSeoBuilders');
  const input = request('delivery.begin', { expectedWrites: 0, products: [], discovery: true });
  const result = await x.handler(input);
  assert.equal(result.ok, false);
  assert.equal(x.read('catalogSeoControl', catalogSeoControlId(config.siteOrigin)), null);
  assert.equal(
    x.read('catalogSeoBuilders', catalogRegionalReceiptId(config.runId, input.requestId)),
    null,
  );
  assert.equal(JSON.stringify(result).includes('secret-signature'), false);
});

test('operation lookup reports not-found and rejects a mismatched receipt hash', async () => {
  const x = fixture();
  const input = request('seed', { productIds: ['p1'], detailEnabled: true });
  const lookup = (inputHash: string) =>
    request('operation.get', { requestId: input.requestId, inputHash }, 'lookup');
  assert.deepEqual((await x.handler(lookup(catalogRegionalRequestHash(input)))).result, {
    state: 'not-found',
  });
  assert.equal((await x.handler(input)).ok, true);
  assert.equal(
    (await x.handler(lookup('0'.repeat(64)))).error?.code,
    'REGIONAL_OPERATION_MISMATCH',
  );
});

test('SDK diagnostics keep only bounded identifiers and preserve product-change classification', async () => {
  for (const [sdkCode, sdkRequestId, expected] of [
    [
      'ResourceUnavailable.TransactionNotExist',
      'request-123',
      { sdkCode: 'ResourceUnavailable.TransactionNotExist', requestId: 'request-123' },
    ],
    ['https://secret.example/token', 'bad\nrequest', {}],
    [
      'STOP_CATALOG_CHANGE',
      'request-456',
      { sdkCode: 'STOP_CATALOG_CHANGE', requestId: 'request-456' },
    ],
  ]) {
    const x = fixture();
    x.store.get = async () => {
      throw Object.assign(new Error('private token and signed URL'), {
        code: sdkCode,
        requestId: sdkRequestId,
      });
    };
    const result = await x.handler(request('delivery.check', { expectedWrites: 0 }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.error?.diagnostic, expected);
    assert.equal(
      result.error?.code,
      sdkCode === 'STOP_CATALOG_CHANGE' ? sdkCode : 'REGIONAL_OPERATION_FAILED',
    );
    assert.equal(JSON.stringify(result).includes('private token'), false);
    assert.equal(JSON.stringify(result).includes('https://secret'), false);
  }
});

test('prepare consumes a real pending product and returns a settled public head', async () => {
  const x = fixture();
  x.put('products', { _id: 'p1', name: 'Headset', published: true, productFamily: 'misc' });
  assert.equal(
    (await x.handler(request('seed', { productIds: ['p1'], detailEnabled: true }))).ok,
    true,
  );
  const result = await x.handler(
    request('prepare.step', { maxItems: 4, detailEnabled: true }, 'prepare'),
  );
  assert.equal(result.ok, true);
  assert.equal(result.result?.ready, true);
  assert.equal(result.result?.processed, 1);
  assert.equal((result.result?.heads as unknown[])?.length, 1);
  assert.ok(
    x.written.every((name) => !['products', 'catalogTaxonomies', 'productVariants'].includes(name)),
  );
});

test('a completed seed unit and missing final reply are reported as partial, never completed', async () => {
  const x = fixture();
  const input = request('seed', { productIds: ['p1'], detailEnabled: true });
  x.failReceipt(catalogRegionalReceiptId(config.runId, input.requestId));
  assert.equal((await x.handler(input)).ok, false);
  const result = await x.handler(
    request(
      'operation.get',
      {
        requestId: input.requestId,
        inputHash: catalogRegionalRequestHash(input),
      },
      'lookup',
    ),
  );
  assert.deepEqual(result.result, { state: 'partial' });
});

test('prepare stops between complete product transactions at its soft deadline', async () => {
  const x = fixture();
  for (let i = 0; i < 5; i++)
    x.put('products', { _id: `p${i}`, name: 'Headset', published: true, productFamily: 'misc' });
  assert.equal(
    (
      await x.handler(
        request('seed', { productIds: ['p0', 'p1', 'p2', 'p3', 'p4'], detailEnabled: true }),
      )
    ).ok,
    true,
  );
  const original = x.store.transaction;
  x.store.transaction = async (operation) => {
    const result = await original(operation);
    x.advance(6000);
    return result;
  };
  const result = await x.handler(
    request('prepare.step', { maxItems: 4, detailEnabled: true }, 'prepare'),
  );
  assert.equal(result.ok, true);
  assert.equal(result.result?.ready, false);
  assert.equal(result.result?.processed, 3);
  assert.equal(result.result?.elapsedMs, 18000);
});

test('a new pending product during head capture prevents readiness', async () => {
  const x = fixture();
  const original = x.store.list;
  let changed = false;
  x.store.list = async (...args) => {
    const result = await original(...args);
    if (args[0] === 'catalogPublicHeads' && !changed) {
      changed = true;
      x.put(
        'catalogSeoRequests',
        createCatalogSeoRequest(
          config.siteOrigin,
          { kind: 'product', productId: 'new-product', previouslyPublic: true },
          new Date(now).toISOString(),
        ),
      );
    }
    return result;
  };
  const result = await x.handler(request('prepare.step', { maxItems: 4, detailEnabled: true }));
  assert.equal(result.ok, true);
  assert.equal(result.result?.ready, false);
});

test('the regional transaction rejects writes outside SEO records', async () => {
  const x = fixture();
  const handler = x.makeHandler((store) => ({
    check: async () => {},
    begin: async () => ({}),
    end: async () => {},
    retryKnownFailure: async () => {},
    accept: () => store.transaction((tx) => tx.set('products', { _id: 'must-not-write' })),
  }));
  const result = await handler(
    request('delivery.accept', { expectedWrites: 0, expectedHeads: [], pages: [] }),
  );
  assert.equal(result.error?.code, 'REGIONAL_WRITE_SCOPE');
  assert.equal(x.read('products', 'must-not-write'), null);
});

test('lease change between the initial read and the write transaction prevents all writes', async () => {
  const x = fixture();
  const original = x.store.transaction;
  x.store.transaction = async (operation) => {
    x.put('siteReleaseTargets', {
      ...x.target,
      lease: { ...guard, runnerRef: config.runnerRef, expiresAt: now + 120000, fence: 99 },
    });
    return original(operation);
  };
  const result = await x.handler(request('seed', { productIds: ['p1'], detailEnabled: true }));
  assert.equal(result.error?.code, 'REGIONAL_LEASE_CHANGED');
  assert.deepEqual(x.written, []);
});

test('the real stateless core survives begin lost-reply, cold end, and cold acceptance', async () => {
  const x = fixture();
  const handler = () => x.makeHandler(createCatalogSeoDeliveryStateless);
  x.put('products', { _id: 'p1', name: 'Headset', published: true, productFamily: 'misc' });
  assert.equal(
    (await handler()(request('seed', { productIds: ['p1'], detailEnabled: true }))).ok,
    true,
  );
  const prepared = await handler()(
    request('prepare.step', { maxItems: 4, detailEnabled: true }, 'prepare'),
  );
  assert.equal(prepared.ok, true);
  const heads = CatalogPublicHeadSchema.array().parse(prepared.result?.heads);
  assert.equal(heads.length, 1);
  const begin = request(
    'delivery.begin',
    { expectedWrites: prepared.result?.writes, products: ['p1'], discovery: false },
    'begin',
  );
  assert.equal((await handler()(begin)).ok, true);
  // The first response is intentionally discarded; the new handler has no memory of it.
  const recovered = await handler()(
    request(
      'operation.get',
      { requestId: begin.requestId, inputHash: catalogRegionalRequestHash(begin) },
      'readback',
    ),
  );
  assert.equal(recovered.ok, true);
  const recoveredReceipt = recovered.result?.receipt;
  assert(recoveredReceipt && typeof recoveredReceipt === 'object' && 'result' in recoveredReceipt);
  const result = recoveredReceipt.result;
  assert(result && typeof result === 'object' && 'ticket' in result && 'expectedHeads' in result);
  assert.deepEqual(result.expectedHeads, heads);
  assert.equal(
    (
      await handler()(
        request(
          'delivery.end',
          { expectedWrites: prepared.result?.writes, ticket: result.ticket, outcome: 'verified' },
          'end',
        ),
      )
    ).ok,
    true,
  );
  const page = { productId: 'p1', htmlSha256: 'd'.repeat(64) };
  const accepted = await handler()(
    request(
      'delivery.accept',
      { expectedWrites: prepared.result?.writes, expectedHeads: heads, pages: [page] },
      'accept',
    ),
  );
  assert.equal(accepted.ok, true);
  assert.equal(
    x.read('catalogSeoPages', catalogPublicRecordId(config.siteOrigin, 'p1'))?.ready,
    true,
  );
  assert.equal((await handler()(begin)).error?.code, 'REGIONAL_TICKET_ENDED');
});

test('regional bundle loads with no workspace packages and refuses an unauthenticated request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-regional-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { buildCatalogRegional } = await import(
    new URL('../../../scripts/catalog-regional-build.mjs', import.meta.url).href
  );
  const built = await buildCatalogRegional(join(root, 'function'), config.codeSha);
  assert.ok(built.bytes > 0 && built.bytes < 8 * 1024 * 1024);
  const output = execFileSync(
    process.execPath,
    ['-e', "require('./index.js').main({}).then(r=>process.stdout.write(JSON.stringify(r)))"],
    { cwd: join(root, 'function'), env: { PATH: process.env.PATH }, timeout: 15000 },
  );
  const result = JSON.parse(output.toString());
  assert.equal(result.ok, false);
  assert.equal(result.codeSha, config.codeSha);
});
