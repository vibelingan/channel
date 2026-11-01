import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCatalogRegionalClient } from './catalog-regional-client.mjs';
import { normalizePolicy } from './release/ledger.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';

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
const { createCatalogSeoDeliveryStateless } = tsxRequire(
  '../packages/db/src/catalog-seo-delivery.ts',
  import.meta.url,
);
const { createCatalogRegionalHandler, catalogRegionalRequestHash } = tsxRequire(
  '../packages/db/src/catalog-seo-regional.ts',
  import.meta.url,
);
const { catalogPublicRecordId } = tsxRequire(
  '../packages/db/src/catalog-public-changes.ts',
  import.meta.url,
);
const { catalogSeoControlId, idleCatalogSeoControl } = tsxRequire(
  '../packages/db/src/catalog-seo-control.ts',
  import.meta.url,
);
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const sdkRequire = createRequire(dbRequire.resolve('@cloudbase/node-sdk/package.json'));

const runId = 'site-41300590230-1';
const codeSha = 'a'.repeat(40);
const runnerRef = 'github:vibelingan/channel:41300590230:attempt-1';
const now = Date.parse('2026-11-01T12:00:00.000Z');
const timestamp = new Date(now).toISOString();
const targetId = normalizePolicy(policy).targetId;
const functionName = 'seo-catalog-region-41300590230-1';
const hash = (body) => createHash('sha256').update(body).digest('hex');

async function fixture(t, { tracked = true } = {}) {
  const f = articleSdkFixture(t);
  // Both application modules use the actual installed SDK. Only its network
  // transport is replaced; CJS/ESM Db constructors can otherwise diverge.
  const originalRequest = f.db.constructor.reqClass;
  const offlineRequest = sdkRequire('@cloudbase/database').Db.reqClass;
  assert.equal(offlineRequest.name, 'Request');
  f.db.constructor.reqClass = offlineRequest;
  t.after(() => {
    f.db.constructor.reqClass = originalRequest;
  });
  const send = offlineRequest.prototype.send;
  let loseNextCommitReply = false;
  offlineRequest.prototype.send = async function (api, params) {
    const result = await Reflect.apply(send, this, [api, params]);
    if (api === 'database.commitTransaction' && loseNextCommitReply) {
      loseNextCommitReply = false;
      throw Object.assign(Error('Synthetic acknowledgement loss after database commit'), {
        code: 'ECONNRESET',
        requestId: 'offline-committed-reply-lost',
      });
    }
    return result;
  };
  t.after(() => {
    offlineRequest.prototype.send = send;
  });
  const store = createCatalogSeoStore(f.db);
  const guard = { targetId, ownerRunId: runId, fence: 7, acquiredVersion: 9 };
  const target = {
    schemaVersion: 1,
    targetId,
    target: normalizePolicy(policy).target,
    policyHash: normalizePolicy(policy).policyHash,
    version: 10,
    nextFence: 7,
    lease: { ...guard, runnerRef, expiresAt: now + 180_000 },
    currentRunId: null,
    dirtyRunId: null,
    unresolvedOperation: null,
  };
  f.put('siteReleaseTargets', targetId, target);
  const controlId = catalogSeoControlId(policy.siteOrigin);
  f.put('catalogSeoControl', controlId, {
    ...idleCatalogSeoControl(policy.siteOrigin, timestamp),
    writes: 7,
    fence: 3,
  });
  for (const productId of ['p1', 'p2']) {
    f.put('products', productId, {
      name: `Customer product ${productId}`,
      productFamily: 'misc',
      published: true,
      archived: false,
    });
    if (!tracked) continue;
    const recordId = catalogPublicRecordId(policy.siteOrigin, productId);
    f.put('catalogPublicHeads', recordId, {
      schemaVersion: 1,
      siteOrigin: policy.siteOrigin,
      productId,
      sequence: 2,
      visible: true,
      semanticHash: 'b'.repeat(64),
      detailRevision: null,
      changedAt: timestamp,
      latestEventId: 'c'.repeat(64),
    });
    f.put('catalogSeoTasks', recordId, {
      schemaVersion: 1,
      siteOrigin: policy.siteOrigin,
      productId,
      requestedSequence: 2,
      acceptedSequence: 1,
      state: 'pending',
      attempts: 0,
      lease: null,
    });
  }
  f.put('articleDrafts', 'customer-draft', { body: 'Retain the current customer draft' });
  const business = new Map(
    [...f.rows].filter(([key]) => /^(?:products|articleDrafts)\//.test(key)),
  );
  const directory = await mkdtemp(join(tmpdir(), 'catalog-regional-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const functions = new Map([['other-app', { detail: { FunctionName: 'other-app' } }]]);
  const requests = [];
  const deleted = [];
  let loseNextReply;
  const manager = {
    getManagerConfig: () => ({ envId: policy.envId, region: policy.region }),
    functions: {
      async listFunctions(limit, offset) {
        return [...functions.values()].map((row) => row.detail).slice(offset, offset + limit);
      },
      async createFunction({ func, force }) {
        assert.equal(force, false);
        assert.equal(func.name, functionName);
        assert.equal(func.type, 'Event');
        assert.equal(func.runtime, 'Nodejs20.19');
        const env = func.envVariables;
        const handler = createCatalogRegionalHandler(
          {
            envId: env.TCB_ENV,
            runId: env.CATALOG_REGIONAL_RUN_ID,
            targetId: env.CATALOG_REGIONAL_TARGET_ID,
            siteOrigin: env.CATALOG_REGIONAL_SITE_ORIGIN,
            codeSha,
            tokenDigest: env.CATALOG_REGIONAL_TOKEN_DIGEST,
            runnerRef: env.CATALOG_REGIONAL_RUNNER_REF,
          },
          {
            createStore: () => store,
            createDelivery: createCatalogSeoDeliveryStateless,
            now: () => now,
          },
        );
        functions.set(func.name, {
          handler,
          detail: {
            FunctionName: func.name,
            Description: func.description,
            Runtime: func.runtime,
            Type: func.type,
            Handler: func.handler,
            Status: 'Active',
            AvailableStatus: 'Available',
            Triggers: [],
            Environment: {
              Variables: Object.entries(env).map(([Key, Value]) => ({ Key, Value })),
            },
          },
        });
      },
      async getFunctionDetail(name) {
        return functions.get(name)?.detail;
      },
      async deleteFunction(name) {
        deleted.push(name);
        functions.delete(name);
      },
      async invokeFunction(name, request) {
        requests.push(structuredClone(request));
        const handler = functions.get(name)?.handler;
        assert.equal(typeof handler, 'function');
        const result = await handler(request);
        if (loseNextReply === request.action) {
          loseNextReply = undefined;
          throw Error('Synthetic reply loss after the real regional handler returned');
        }
        return {
          RequestId: `offline-invoke-${requests.length}`,
          InvokeFinished: 1,
          RetCode: 0,
          RetMsg: JSON.stringify(result),
        };
      },
    },
  };
  const start = () =>
    createCatalogRegionalClient({
      manager,
      policy,
      runId,
      codeSha,
      runnerRef,
      guard,
      directory,
      requestHash: catalogRegionalRequestHash,
      withLease: (operation) => operation(),
      build: async (_directory, source) => assert.equal(source, codeSha),
      wait: async () => {},
      mask: () => {},
      onStatus: () => {},
    });
  const assertBusinessUnchanged = () => {
    assert.deepEqual(
      new Map([...f.rows].filter(([key]) => /^(?:products|articleDrafts)\//.test(key))),
      business,
    );
    assert.equal(
      f.calls.filter(
        (call) =>
          call.api === 'database.modifyDocument' &&
          ['products', 'articleDrafts'].includes(call.params.collectionName),
      ).length,
      0,
    );
  };
  return {
    ...f,
    store,
    guard,
    target,
    controlId,
    manager,
    directory,
    requests,
    deleted,
    functions,
    start,
    loseReply(action) {
      loseNextReply = action;
    },
    loseDatabaseCommitReply() {
      loseNextCommitReply = true;
    },
    assertBusinessUnchanged,
    receipt: async () => JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')),
  };
}

test('committed begin reply loss restores the exact real ticket and captured heads, and a closed ticket cannot be replayed', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  const catalog = await client.prepare({ detailEnabled: true });
  f.loseReply('delivery.begin');
  const ticket = await catalog.delivery.begin(['p1', 'p2']);
  assert.deepEqual(ticket.products, ['p1', 'p2']);
  assert.equal(f.requests.filter((request) => request.action === 'delivery.begin').length, 1);
  assert.ok(
    (await f.receipt()).calls.some(
      (call) => call.action === 'delivery.begin' && call.state === 'readback-confirmed',
    ),
  );
  assert.deepEqual(catalog.delivery.trackedProducts, ['p1', 'p2']);
  const storedControl = f.rows.get(`catalogSeoControl/${f.controlId}`);
  assert.equal(storedControl.owner, ticket.owner);
  assert.equal(storedControl.fence, ticket.fence);
  for (const productId of ['p1', 'p2']) {
    const task = f.rows.get(
      `catalogSeoTasks/${catalogPublicRecordId(policy.siteOrigin, productId)}`,
    );
    assert.equal(task.state, 'writing');
    assert.equal(task.lease.runId, runId);
  }
  await catalog.delivery.end(ticket, 'verified');
  const begin = f.requests.find((request) => request.action === 'delivery.begin');
  const replay = {
    ...begin,
    requestId: randomUUID(),
    action: 'operation.get',
    input: { requestId: begin.requestId, inputHash: catalogRegionalRequestHash(begin) },
  };
  const observed = JSON.parse(
    (await f.manager.functions.invokeFunction(functionName, replay)).RetMsg,
  );
  assert.equal(observed.ok, false);
  assert.equal(observed.error.code, 'REGIONAL_TICKET_ENDED');
  assert.equal(f.rows.get(`catalogSeoControl/${f.controlId}`).state, 'idle');
  await assert.rejects(catalog.delivery.end(ticket, 'verified'), /Unknown/);
  f.assertBusinessUnchanged();
  await client.close();
  assert.deepEqual(f.deleted, [functionName]);
  assert.equal(f.functions.has('other-app'), true);
});

test('real regional preparation and two-page acceptance preserve business rows and clean only their function', async (t) => {
  const f = await fixture(t, { tracked: false });
  const client = await f.start();
  const seeded = await client.seed(['p1', 'p2', 'p1'], { detailEnabled: true });
  assert.deepEqual(seeded, { queued: 2, preserved: 0, tracked: 0, upgraded: 0 });
  const catalog = await client.prepare({ detailEnabled: true });
  assert.equal(catalog.writes, 7);
  assert.equal(catalog.heads.length, 2);
  catalog.delivery.primeExpectedHeads(catalog.heads);
  const pages = catalog.heads.map((head) => ({
    productId: head.productId,
    htmlSha256: hash(`<h1>Customer product ${head.productId}</h1>`),
  }));
  await catalog.delivery.accept(pages);
  assert.equal(f.requests.filter((request) => request.action === 'delivery.accept').length, 1);
  for (const page of pages) {
    const recordId = catalogPublicRecordId(policy.siteOrigin, page.productId);
    assert.equal(f.rows.get(`catalogSeoTasks/${recordId}`).state, 'accepted');
    assert.equal(f.rows.get(`catalogSeoTasks/${recordId}`).acceptedSequence, 1);
    assert.equal(f.rows.get(`catalogSeoPages/${recordId}`).htmlSha256, page.htmlSha256);
    assert.equal(f.rows.get(`catalogSeoPages/${recordId}`).ready, true);
  }
  assert.ok(
    f.calls.some(
      (call) =>
        call.api === 'database.modifyDocument' &&
        call.params.collectionName === 'siteReleaseTargets',
    ),
    'Regional writes must obtain the real target-document write conflict',
  );
  f.assertBusinessUnchanged();
  await client.close();
  assert.deepEqual(f.deleted, [functionName]);
  assert.equal(f.functions.has('other-app'), true);
});

test('an owner change before regional commit prevents its control, task and receipt writes', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  const catalog = await client.prepare({ detailEnabled: true });
  const before = structuredClone(f.rows.get(`catalogSeoControl/${f.controlId}`));
  f.control.beforeCommit = () => {
    f.control.beforeCommit = undefined;
    f.put('siteReleaseTargets', targetId, {
      ...f.target,
      version: 11,
      nextFence: 8,
      lease: {
        ...f.target.lease,
        ownerRunId: 'site-41300590231-1',
        runnerRef: 'github:vibelingan/channel:41300590231:attempt-1',
        fence: 8,
      },
    });
  };
  await assert.rejects(catalog.delivery.begin(['p1']), { code: 'REGIONAL_LEASE_CHANGED' });
  assert.deepEqual(f.rows.get(`catalogSeoControl/${f.controlId}`), before);
  assert.equal(
    f.rows.get(`catalogSeoTasks/${catalogPublicRecordId(policy.siteOrigin, 'p1')}`).state,
    'pending',
  );
  assert.equal(f.rows.get(`siteReleaseTargets/${targetId}`).lease.ownerRunId, 'site-41300590231-1');
  f.assertBusinessUnchanged();
  await client.close();
  assert.deepEqual(f.deleted, [functionName]);
  assert.equal(f.functions.has('other-app'), true);
});

test('a database commit acknowledgement lost inside a completed invocation is recovered from its atomic receipt', async (t) => {
  const f = await fixture(t);
  const client = await f.start();
  const catalog = await client.prepare({ detailEnabled: true });
  f.loseDatabaseCommitReply();
  const ticket = await catalog.delivery.begin(['p1', 'p2']);
  assert.equal(f.requests.filter((request) => request.action === 'delivery.begin').length, 1);
  assert.ok(
    (await f.receipt()).calls.some(
      (call) => call.action === 'delivery.begin' && call.state === 'readback-confirmed',
    ),
  );
  assert.equal(f.rows.get(`catalogSeoControl/${f.controlId}`).owner, ticket.owner);
  await catalog.delivery.end(ticket, 'verified');
  assert.equal(f.rows.get(`catalogSeoControl/${f.controlId}`).state, 'idle');
  f.assertBusinessUnchanged();
  await client.close();
  assert.deepEqual(f.deleted, [functionName]);
  assert.equal(f.functions.has('other-app'), true);
});
