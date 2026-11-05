import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { wakeCatalog } from './release/catalog-wakeup.mjs';
import { normalizePolicy, tables } from './release/ledger.mjs';
import { SITE_DELIVERY_POLICY } from './release/site-policy.mjs';

const { require: tsxRequire } = createRequire(
  new URL('../apps/site/package.json', import.meta.url),
)('tsx/cjs/api');
const { createCatalogClockStore } = tsxRequire(
  '../tools/catalog-seo-clock/store.mjs',
  import.meta.url,
);
const { articleSdkFixture } = tsxRequire(
  '../packages/db/src/article-sdk-fixture.test-helper.ts',
  import.meta.url,
);
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const sdkRequire = createRequire(dbRequire.resolve('@cloudbase/node-sdk/package.json'));
const config = normalizePolicy(SITE_DELIVERY_POLICY);
const scopeId = `${config.targetId}-site`;
const sourceRunId = 'site-123-1';
const nonce = '12345678-1234-1234-1234-123456789012';

function fixture(t) {
  const f = articleSdkFixture(t);
  const originalRequest = f.db.constructor.reqClass;
  const offlineRequest = sdkRequire('@cloudbase/database').Db.reqClass;
  assert.equal(offlineRequest.name, 'Request');
  f.db.constructor.reqClass = offlineRequest;
  t.after(() => {
    f.db.constructor.reqClass = originalRequest;
  });
  const target = {
    schemaVersion: 1,
    targetId: config.targetId,
    policyHash: config.policyHash,
    target: config.target,
    version: 5,
    nextFence: 1,
    lease: null,
    currentRunId: null,
    dirtyRunId: null,
    unresolvedOperation: null,
  };
  const pointer = { sourceRunId, activationId: 'activation-123', compositionHash: 'd'.repeat(64) };
  const scope = {
    schemaVersion: 1,
    targetId: config.targetId,
    scopeKey: 'site',
    scope: { kind: 'site' },
    version: 1,
    active: pointer,
    baseline: pointer,
  };
  const active = {
    codeSha: 'a'.repeat(40),
    executorSha: 'b'.repeat(40),
    executorRef: 'feat/seo-foundation',
    manifestSha256: 'c'.repeat(64),
    acceptedRunId: sourceRunId,
    catalogTracked: true,
  };
  f.put(tables.targets, config.targetId, target);
  f.put(tables.scopes, scopeId, scope);
  f.put('catalogSeoBuilders', 'active', active);
  f.put('catalogSeoRequests', 'pending', {
    siteOrigin: config.target.siteOrigin,
    state: 'pending',
  });
  const notifications = [];
  const github = {
    head: async () => active.executorSha,
    passedCI: async () => true,
    runs: async () => [],
    dispatch: async (...args) => notifications.push(args),
  };
  const store = createCatalogClockStore(f.db);
  return {
    ...f,
    target,
    scope,
    active,
    notifications,
    github,
    store,
    async run() {
      return store.outcome(await wakeCatalog({ store, github, now: 1000, nonce }));
    },
  };
}

test('the installed SDK checks the current accepted site inside the notification claim transaction', async (t) => {
  const f = fixture(t);
  assert.equal((await f.run()).status, 'sent');
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0][1].inputs.renderer_sha, f.active.codeSha);
  const write = f.calls.find(
    (call) =>
      call.api === 'database.modifyDocument' && call.params.collectionName === 'catalogSeoWakeups',
  );
  assert(write?.params.transactionId);
  for (const collectionName of [tables.targets, tables.scopes, 'catalogSeoBuilders'])
    assert(
      f.calls.some(
        (call) =>
          call.api === 'database.getDocument' &&
          call.params.collectionName === collectionName &&
          call.params.transactionId === write.params.transactionId,
      ),
    );
  assert.equal(f.rows.get('catalogSeoWakeups/supplychainsai-com').state, 'sent');
});

for (const [label, patch, expected] of [
  [
    'old A program after B website acceptance',
    (f) => {
      const pointer = {
        ...f.scope.baseline,
        sourceRunId: 'site-456-1',
        activationId: 'activation-456',
      };
      f.put(tables.scopes, scopeId, { ...f.scope, active: pointer, baseline: pointer });
    },
    'registration-incomplete',
  ],
  [
    'missing target',
    (f) => f.rows.delete(`${tables.targets}/${config.targetId}`),
    'registration-incomplete',
  ],
  [
    'missing site scope',
    (f) => f.rows.delete(`${tables.scopes}/${scopeId}`),
    'registration-incomplete',
  ],
  [
    'missing active program',
    (f) => f.rows.delete('catalogSeoBuilders/active'),
    'registration-incomplete',
  ],
  [
    'untracked program',
    (f) => f.put('catalogSeoBuilders', 'active', { ...f.active, catalogTracked: false }),
    'registration-incomplete',
  ],
  [
    'wrong target environment',
    (f) =>
      f.put(tables.targets, config.targetId, {
        ...f.target,
        target: { ...f.target.target, envId: 'foreign' },
      }),
    'registration-incomplete',
  ],
  [
    'dirty website',
    (f) => f.put(tables.targets, config.targetId, { ...f.target, dirtyRunId: 'site-456-1' }),
    'delivery-needs-readback',
  ],
  [
    'unknown cloud operation',
    (f) =>
      f.put(tables.targets, config.targetId, {
        ...f.target,
        unresolvedOperation: { runId: 'site-456-1', stepId: 'upload', operationId: 'operation-1' },
      }),
    'delivery-needs-readback',
  ],
  [
    'active deployment',
    (f) => f.put(tables.targets, config.targetId, { ...f.target, currentRunId: 'site-456-1' }),
    'delivery-busy',
  ],
  [
    'held deployment lease',
    (f) =>
      f.put(tables.targets, config.targetId, {
        ...f.target,
        lease: {
          ownerRunId: 'site-456-1',
          runnerRef: 'github:vibelingan/channel:456:attempt-1',
          fence: 1,
          acquiredVersion: 5,
          expiresAt: 2000,
        },
      }),
    'delivery-busy',
  ],
  [
    'expired deployment lease',
    (f) =>
      f.put(tables.targets, config.targetId, {
        ...f.target,
        lease: {
          ownerRunId: 'site-456-1',
          runnerRef: 'github:vibelingan/channel:456:attempt-1',
          fence: 1,
          acquiredVersion: 5,
          expiresAt: 1,
        },
      }),
    'delivery-busy',
  ],
]) {
  test(`${label} never notifies GitHub`, async (t) => {
    const f = fixture(t);
    patch(f);
    assert.equal((await f.run()).status, expected);
    assert.deepEqual(f.notifications, []);
    assert.equal(f.rows.has('catalogSeoWakeups/supplychainsai-com'), false);
  });
}

test('B accepted while GitHub is being checked blocks notification for the old A program', async (t) => {
  const f = fixture(t);
  f.github.runs = async () => {
    const pointer = {
      ...f.scope.baseline,
      sourceRunId: 'site-456-1',
      activationId: 'activation-456',
    };
    f.put(tables.scopes, scopeId, { ...f.scope, active: pointer, baseline: pointer });
    return [];
  };
  assert.equal((await f.run()).status, 'registration-incomplete');
  assert.deepEqual(f.notifications, []);
  assert.equal(f.rows.has('catalogSeoWakeups/supplychainsai-com'), false);
});

test('a newer complete registration during GitHub checks waits for the next timer instead of notifying with the old selection', async (t) => {
  const f = fixture(t);
  f.github.runs = async () => {
    const pointer = {
      ...f.scope.baseline,
      sourceRunId: 'site-456-1',
      activationId: 'activation-456',
    };
    f.put(tables.scopes, scopeId, { ...f.scope, active: pointer, baseline: pointer });
    f.put('catalogSeoBuilders', 'active', {
      ...f.active,
      codeSha: 'e'.repeat(40),
      acceptedRunId: 'site-456-1',
    });
    return [];
  };
  assert.equal((await f.run()).status, 'registration-changed');
  assert.deepEqual(f.notifications, []);
  assert.equal(f.rows.has('catalogSeoWakeups/supplychainsai-com'), false);
});

test('an SDK read error does not become a ready program or a notification', async (t) => {
  const f = fixture(t);
  f.control.returnedReadError = true;
  await assert.rejects(f.run());
  assert.deepEqual(f.notifications, []);
  assert.equal(f.rows.has('catalogSeoWakeups/supplychainsai-com'), false);
});

test('an empty queue does not read registration or claim a notification', async (t) => {
  const f = fixture(t);
  f.rows.delete('catalogSeoRequests/pending');
  assert.deepEqual(await f.run(), { status: 'idle' });
  assert.deepEqual(f.notifications, []);
  assert.equal(
    f.calls.some((call) => call.api === 'database.startTransaction'),
    false,
  );
});
