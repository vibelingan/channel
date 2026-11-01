import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogPublicHeadSchema, catalogPublicRecordId } from './catalog-public-changes.ts';
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
