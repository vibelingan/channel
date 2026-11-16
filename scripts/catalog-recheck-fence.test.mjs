import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  assertCatalogRecheckRuntime,
  assertCatalogRecheckSite,
  catalogRecheckInventoryFetch,
  createCatalogRecheckFence,
} from './release/catalog-recheck-fence.mjs';
import { identity } from './release/input.mjs';
import { normalizePolicy } from './release/ledger.mjs';

const { require: tsxRequire } = createRequire(
  new URL('../apps/site/package.json', import.meta.url),
)('tsx/cjs/api');
const { articleSdkFixture } = tsxRequire(
  '../packages/db/src/article-sdk-fixture.test-helper.ts',
  import.meta.url,
);
const { createCatalogSeoStore } = tsxRequire(
  '../packages/db/src/catalog-seo-cloud.ts',
  import.meta.url,
);
const { recheckCatalogSeoRequests } = tsxRequire(
  '../packages/db/src/catalog-seo-recheck.ts',
  import.meta.url,
);
const { collectPublicProductPaths } = tsxRequire(
  '../apps/site/src/lib/seo/product-snapshot.ts',
  import.meta.url,
);
const { runCatalogRuntimeRecheck } = tsxRequire('./recheck-catalog-runtime.ts', import.meta.url);
const policy = {
  repository: 'fixture/channel',
  envId: 'fixture-env',
  siteOrigin: 'https://fixture.example',
};
const expectedAcceptedRunId = 'site-101-1';
const expectedExecutorSha = 'a'.repeat(40);

test('the real maintenance entry refuses missing confirmation or foreign target before making SDK calls', async () => {
  const previous = process.env.CATALOG_RECHECK_CONFIRM;
  const input = {
    config: { secretId: 'fixture', secretKey: 'never-use-these-for-a-live-call' },
    expectedAcceptedRunId,
    expectedExecutorSha,
    outputDirectory: 'output/catalog-recheck-must-not-start',
  };
  try {
    process.env.CATALOG_RECHECK_CONFIRM = 'not-confirmed';
    await assert.rejects(runCatalogRuntimeRecheck(input), /queue-only confirmation/);
    process.env.CATALOG_RECHECK_CONFIRM = 'QUEUE_ONLY_NO_CONTENT_WRITES';
    for (const config of [
      { ...input.config, envId: 'other-app' },
      { ...input.config, region: 'other-region' },
      { ...input.config, token: 'one', sessionToken: 'different' },
    ])
      await assert.rejects(runCatalogRuntimeRecheck({ ...input, config }), /fixed target/);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'CATALOG_RECHECK_CONFIRM');
    else process.env.CATALOG_RECHECK_CONFIRM = previous;
  }
});

function records(envId = policy.envId) {
  const selected = { ...policy, envId };
  const config = normalizePolicy(selected);
  const composition = { static: { codeSha: expectedExecutorSha } };
  const pointer = {
    activationId: 'accepted-activation',
    sourceRunId: expectedAcceptedRunId,
    compositionHash: identity(composition),
  };
  const targetRow = {
    _id: config.targetId,
    schemaVersion: 1,
    targetId: config.targetId,
    target: config.target,
    policyHash: config.policyHash,
    version: 10,
    nextFence: 2,
    lease: null,
    currentRunId: null,
    dirtyRunId: null,
    unresolvedOperation: null,
  };
  const scopeRow = {
    _id: `${config.targetId}-site`,
    schemaVersion: 1,
    targetId: config.targetId,
    scopeKey: 'site',
    scope: config.scopes.site,
    version: 4,
    active: pointer,
    baseline: pointer,
  };
  const proof = {
    _id: 'runtime-activation',
    schemaVersion: 2,
    purpose: 'catalog-writer-recovery',
    siteOrigin: selected.siteOrigin,
    executorSha: expectedExecutorSha,
    sourceRunId: '100',
    previousActivationHash: 'b'.repeat(64),
    configurationHash: 'c'.repeat(64),
    maximumTimeoutSeconds: 20,
    observedAt: 0,
    usableAfter: 140_000,
    accepted: true,
    acceptedAt: 140_000,
    writerVersions: [
      { name: 'admin', releaseId: 'd'.repeat(40) },
      { name: 'alibaba-catalog-sync', releaseId: 'e'.repeat(40) },
    ],
  };
  return {
    policy: selected,
    targetRow,
    scopeRow,
    expectedAcceptedRunId,
    expectedExecutorSha,
    proof,
    status: {
      targetId: config.targetId,
      state: 'idle',
      pendingStep: null,
      target: targetRow,
      scope: scopeRow,
    },
    run: {
      runId: expectedAcceptedRunId,
      state: 'SUCCEEDED',
      scopeKey: 'site',
      targetId: config.targetId,
      composition,
      compositionHash: pointer.compositionHash,
      accepted: { ...pointer, acceptedAt: 200_000 },
    },
    active: {
      acceptedRunId: expectedAcceptedRunId,
      codeSha: expectedExecutorSha,
      executorSha: expectedExecutorSha,
      executorRef: 'feat/seo-foundation',
      manifestSha256: 'f'.repeat(64),
      catalogTracked: true,
    },
  };
}

test('SDK raw IDs and exact target/scope versions form a read-only per-transaction publication fence', async () => {
  const x = records();
  const fence = createCatalogRecheckFence(x);
  const reads = [];
  await fence.assertCanQueue({
    get: async (collection, id) => {
      reads.push([collection, id]);
      return collection === 'siteReleaseTargets' ? x.targetRow : x.scopeRow;
    },
  });
  assert.deepEqual(reads, [
    ['siteReleaseTargets', x.targetRow._id],
    ['siteReleaseScopes', x.scopeRow._id],
  ]);
  assert.equal(fence.receipt.targetVersion, 10);
  assert.equal(fence.receipt.scopeVersion, 4);
  for (const mutate of [
    (r) => {
      r.targetRow._id = 'wrong-id';
    },
    (r) => {
      r.targetRow.version++;
    },
    (r) => {
      r.scopeRow.version++;
    },
    (r) => {
      r.targetRow.currentRunId = 'publisher-started';
    },
    (r) => {
      r.targetRow.unresolvedOperation = { runId: 'run', stepId: 'step', operationId: 'operation' };
    },
    (r) => {
      r.scopeRow.baseline = { ...r.scopeRow.baseline, sourceRunId: 'site-102-1' };
    },
  ]) {
    const changed = records();
    mutate(changed);
    assert.throws(() => fence.assertUnchanged(changed.targetRow, changed.scopeRow));
  }
});

test('actual SDK transaction retries re-read the full fence and cannot queue after a publisher starts', async (t) => {
  const sdk = articleSdkFixture(t);
  const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const sdkRequire = createRequire(dbRequire.resolve('@cloudbase/node-sdk/package.json'));
  const originalRequest = sdk.db.constructor.reqClass;
  sdk.db.constructor.reqClass = sdkRequire('@cloudbase/database').Db.reqClass;
  t.after(() => {
    sdk.db.constructor.reqClass = originalRequest;
  });
  const x = records(sdk.db.config.env);
  const fence = createCatalogRecheckFence(x);
  sdk.put('siteReleaseTargets', x.targetRow._id, x.targetRow);
  sdk.put('siteReleaseScopes', x.scopeRow._id, x.scopeRow);
  sdk.control.beforeCommit = () => {
    sdk.control.beforeCommit = undefined;
    sdk.put('siteReleaseTargets', x.targetRow._id, {
      ...x.targetRow,
      version: 11,
      currentRunId: 'publisher-started',
    });
  };
  await assert.rejects(
    recheckCatalogSeoRequests(
      createCatalogSeoStore(sdk.db),
      { siteOrigin: x.policy.siteOrigin, detailEnabled: true },
      ['previously-public'],
      '2026-11-16T00:00:00.000Z',
      fence.assertCanQueue,
    ),
  );
  assert.equal(
    [...sdk.rows.keys()].some((key) => key.startsWith('catalogSeoRequests/')),
    false,
  );
  assert.ok(sdk.calls.filter((call) => call.api === 'database.startTransaction').length >= 2);
  assert.ok(
    sdk.calls
      .filter((call) => call.api === 'database.modifyDocument')
      .every((call) => call.params.collectionName === 'catalogSeoRequests'),
  );
});

test('the real public envelope is consumed by the existing inventory collector without detail calls', async () => {
  const budget = { publicListReads: 0 };
  const fetcher = catalogRecheckInventoryFetch({
    budget,
    request: async (method, url, options) => {
      assert.equal(method, 'GET');
      assert.equal(new URL(url).pathname, '/api/products');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.timeoutMs, 20_000);
      return {
        status: 200,
        headers: new Headers(),
        body: Buffer.from(
          JSON.stringify({
            ok: true,
            data: {
              items: [{ _id: 'current', name: 'Headset', category: '' }],
              page: 1,
              pageSize: 48,
              total: 1,
            },
          }),
        ),
      };
    },
  });
  assert.deepEqual(await collectPublicProductPaths(policy.siteOrigin, fetcher), [
    '/products/p-current/',
  ]);
  assert.equal(budget.publicListReads, 1);
  for (const body of [
    { total: 1 },
    { ok: true, data: { total: 50_001 } },
    { ok: false, data: { total: 0 } },
  ]) {
    const invalid = catalogRecheckInventoryFetch({
      budget: { publicListReads: 0 },
      request: async () => ({
        status: 200,
        body: Buffer.from(JSON.stringify(body)),
        headers: new Headers(),
      }),
    });
    await assert.rejects(invalid('https://fixture.example/api/products', {}));
  }
});

test('the selected accepted site accepts the exact SDK proof ID and rejects a foreign or old program', () => {
  const x = records();
  assert.deepEqual(assertCatalogRecheckSite(x), x.scopeRow.baseline);
  for (const mutate of [
    (r) => {
      r.proof._id = 'another-record';
    },
    (r) => {
      r.proof.accepted = false;
    },
    (r) => {
      r.active.executorSha = '0'.repeat(40);
    },
    (r) => {
      r.active.codeSha = '0'.repeat(40);
    },
    (r) => {
      r.run.state = 'FAILED';
    },
    (r) => {
      r.run.accepted.acceptedAt = 1;
    },
    (r) => {
      r.run.accepted.activationId = 'another-activation';
    },
  ]) {
    const changed = records();
    mutate(changed);
    assert.throws(() => assertCatalogRecheckSite(changed));
  }
});

test('running writer flags and versions must match the proof and the owned clock must remain off', () => {
  const x = records();
  const detail = (name, entries) => ({
    FunctionName: name,
    Namespace: policy.envId,
    Status: 'Active',
    AvailableStatus: 'Available',
    Runtime: 'Nodejs20.19',
    Type: 'Event',
    Handler: 'index.main',
    CodeSize: 100,
    Environment: { Variables: Object.entries(entries).map(([Key, Value]) => ({ Key, Value })) },
  });
  const runtime = {
    ...x,
    writers: x.proof.writerVersions.map(({ name, releaseId }) => ({
      name,
      detail: detail(name, {
        TCB_ENV: policy.envId,
        CATALOG_SEO_RECORDING: '1',
        CATALOG_DETAIL_APPROVAL_ENABLED: '1',
        CATALOG_SEO_SITE_ORIGIN: policy.siteOrigin,
        PRIVATE_SECRET: 'keep-private',
      }),
      health: { releaseId, catalogSeoRecording: true },
    })),
    clock: {
      ...detail('catalog-seo-clock', { CATALOG_SEO_CLOCK_ENABLED: '0' }),
      Description: 'channel-catalog-seo-clock-v1',
    },
  };
  const before = assertCatalogRecheckRuntime(runtime);
  runtime.writers[0].detail.Environment.Variables.reverse();
  assert.deepEqual(assertCatalogRecheckRuntime(runtime), before);
  for (const mutate of [
    (r) => {
      r.writers[0].health.releaseId = '0'.repeat(40);
    },
    (r) => {
      r.writers[0].health.catalogSeoRecording = false;
    },
    (r) => {
      r.writers[0].detail.Environment.Variables.find(
        (v) => v.Key === 'CATALOG_SEO_RECORDING',
      ).Value = '0';
    },
    (r) => {
      r.clock.Environment.Variables[0].Value = '1';
    },
    (r) => {
      r.clock.Description = 'other-app';
    },
  ]) {
    const changed = structuredClone(runtime);
    mutate(changed);
    assert.throws(() => assertCatalogRecheckRuntime(changed));
  }
});
