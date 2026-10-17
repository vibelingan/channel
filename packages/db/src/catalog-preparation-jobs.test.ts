import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CATALOG_PREPARATION_POLICY,
  CatalogPreparationRequestSchema,
} from '@vibelingan-channel/shared/catalog-preparation';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import { advanceCatalogProduct, isCatalogProductManagedField } from './catalog-product-state.ts';
function fixture() {
  let now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'server-test-secret',
    environmentId: 'test',
    now: () => now,
  });
  const records: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': { _id: 'p', name: 'Clock', catalogContentGeneration: 3, published: false },
  };
  let writes = 0;
  const tx = {
    get: async (c: string, id: string) => structuredClone(records[`${c}/${id}`] ?? null),
    set: async (c: string, row: CollectionDoc) => {
      writes++;
      records[`${c}/${row._id}`] = structuredClone(row);
    },
  };
  const run = (command: Parameters<typeof runCatalogPreparationJob>[2]) =>
    runCatalogPreparationJob(tx, authority, command, now);
  async function start() {
    const r = await run({ action: 'start', actorId: 'admin', productId: 'p' });
    assert.ok(r.ok && 'progress' in r);
    return r.progress;
  }
  async function call(jobId: string) {
    const r = await run({ action: 'dispatch', actorId: 'admin', jobId });
    assert.ok(r.ok && 'call' in r);
    return r.call;
  }
  async function claim(jobId: string, owner = 'worker') {
    const r = await run({ action: 'claim', call: await call(jobId), owner });
    assert.ok(r.ok && 'lease' in r);
    return r;
  }
  return {
    records,
    tx,
    run,
    start,
    call,
    claim,
    authority,
    get writes() {
      return writes;
    },
    set now(v: number) {
      now = v;
    },
    get now() {
      return now;
    },
  };
}
test('same input creation survives lost ACK with unchanged business fields and one job', async () => {
  const f = fixture();
  const before = structuredClone(f.records['products/p']);
  const a = await f.start();
  const b = await f.start();
  assert.deepEqual(a, b);
  assert.equal(f.writes, 2);
  const business = Object.fromEntries(
    Object.entries(f.records['products/p'] ?? {}).filter(
      ([key]) =>
        ![
          'catalogPreparationState',
          'catalogPreparationPolicy',
          'catalogPreparationRequest',
        ].includes(key),
    ),
  );
  assert.deepEqual(business, before);
  assert.equal(JSON.stringify(a).includes('nonce'), false);
  assert.equal(JSON.stringify(a).includes('signature'), false);
});
test('signed admission claims a current private job for technical work', async () => {
  const f = fixture();
  const p = await f.start();
  const r = await f.claim(p.jobId);
  assert.equal(r.progress.state, 'running');
  assert.equal(r.progress.leaseVersion, 1);
  assert.equal(r.progress.attempt, 1);
  assert.equal(JSON.stringify(r.lease), '{}');
  assert.ok(f.authority.currentLeaseScope(r.lease, f.records[`catalogPreparationJobs/${p.jobId}`]));
});
test('a second worker cannot claim even with the same owner before expiry', async () => {
  const f = fixture();
  const p = await f.start();
  await f.claim(p.jobId);
  for (const owner of ['worker', 'other'])
    assert.deepEqual(await f.run({ action: 'claim', call: await f.call(p.jobId), owner }), {
      ok: false,
      code: 'BUSY',
    });
});
test('unsigned timer or changed nonce cannot write a job', async () => {
  const f = fixture();
  const p = await f.start();
  const call = await f.call(p.jobId);
  const before = f.writes;
  for (const value of [{ Type: 'Timer' }, { ...call, nonce: 'f'.repeat(64) }])
    assert.deepEqual(await f.run({ action: 'claim', call: value, owner: 'worker' }), {
      ok: false,
      code: 'FORBIDDEN',
    });
  assert.equal(f.writes, before);
});
test('expired takeover increments version and fences old worker', async () => {
  const f = fixture();
  const p = await f.start();
  const old = await f.claim(p.jobId);
  f.now += 120001;
  const fresh = await f.claim(p.jobId, 'second');
  assert.equal(fresh.progress.leaseVersion, 2);
  assert.equal(fresh.progress.attempt, 2);
  const before = f.writes;
  for (const action of ['renew', 'release'] as const)
    assert.deepEqual(await f.run({ action, jobId: p.jobId, lease: old.lease }), {
      ok: false,
      code: 'CONFLICT',
    });
  assert.equal(f.writes, before);
});
test('renew and release allow the next fenced step', async () => {
  const f = fixture();
  const p = await f.start();
  const r = await f.claim(p.jobId);
  f.now += 1000;
  assert.ok((await f.run({ action: 'renew', jobId: p.jobId, lease: r.lease })).ok);
  assert.ok((await f.run({ action: 'release', jobId: p.jobId, lease: r.lease })).ok);
  assert.equal((await f.claim(p.jobId)).progress.leaseVersion, 2);
  assert.deepEqual(await f.run({ action: 'release', jobId: p.jobId, lease: r.lease }), {
    ok: false,
    code: 'CONFLICT',
  });
});
test('fenced cancel and explicit retry rotate nonce, old calls and cancels cannot revive', async () => {
  const f = fixture();
  const p = await f.start();
  const call = await f.call(p.jobId);
  const r = await f.claim(p.jobId);
  assert.deepEqual(
    await f.run({ action: 'cancel', actorId: 'admin', jobId: p.jobId, expectedLeaseVersion: 0 }),
    { ok: false, code: 'CONFLICT' },
  );
  assert.ok(
    (await f.run({ action: 'cancel', actorId: 'admin', jobId: p.jobId, expectedLeaseVersion: 1 }))
      .ok,
  );
  assert.equal((await f.start()).state, 'cancelled');
  assert.deepEqual(await f.run({ action: 'renew', jobId: p.jobId, lease: r.lease }), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.ok(
    (await f.run({ action: 'retry', actorId: 'admin', jobId: p.jobId, expectedLeaseVersion: 1 }))
      .ok,
  );
  const before = f.writes;
  assert.deepEqual(await f.run({ action: 'claim', call, owner: 'late' }), {
    ok: false,
    code: 'FORBIDDEN',
  });
  assert.equal(f.writes, before);
  assert.equal((await f.claim(p.jobId)).progress.leaseVersion, 3);
  assert.deepEqual(
    await f.run({ action: 'cancel', actorId: 'admin', jobId: p.jobId, expectedLeaseVersion: 1 }),
    { ok: false, code: 'CONFLICT' },
  );
});
for (const change of [
  { name: 'Edited' },
  { catalogContentGeneration: 4 },
  { alibabaPrimarySourceKey: 'new' },
])
  test(`changed product rejects old preparation ${Object.keys(change)[0]}`, async () => {
    const f = fixture();
    const p = await f.start();
    const r = await f.claim(p.jobId);
    Object.assign(f.records['products/p'] ?? {}, change);
    assert.deepEqual(await f.run({ action: 'renew', jobId: p.jobId, lease: r.lease }), {
      ok: false,
      code: 'STALE',
    });
    assert.equal(f.records[`catalogPreparationJobs/${p.jobId}`]?.state, 'stale');
    assert.equal(f.records['products/p']?.published, false);
  });
for (const action of ['start', 'get', 'cancel', 'retry', 'dispatch'] as const)
  test(`human ${action} rechecks actual admin row`, async () => {
    const f = fixture();
    const p = await f.start();
    f.records['users/admin'] = { _id: 'admin', role: 'user' };
    const before = f.writes;
    assert.deepEqual(
      await f.run(
        action === 'start'
          ? { action, actorId: 'admin', productId: 'p' }
          : action === 'cancel' || action === 'retry'
            ? { action, actorId: 'admin', jobId: p.jobId, expectedLeaseVersion: 0 }
            : { action, actorId: 'admin', jobId: p.jobId },
      ),
      { ok: false, code: 'FORBIDDEN' },
    );
    assert.equal(f.writes, before);
  });
test('forged or serialized capability cannot renew or release', async () => {
  const f = fixture();
  const p = await f.start();
  const r = await f.claim(p.jobId);
  const before = f.writes;
  for (const lease of [{}, JSON.parse(JSON.stringify(r.lease))])
    for (const action of ['renew', 'release'] as const)
      assert.deepEqual(await f.run({ action, jobId: p.jobId, lease }), {
        ok: false,
        code: 'CONFLICT',
      });
  assert.equal(f.writes, before);
});
test('invalid state and version overflow reject without repairing corrupt row', async () => {
  const f = fixture();
  const p = await f.start();
  const job = f.records[`catalogPreparationJobs/${p.jobId}`];
  assert.ok(job);
  job.state = 'bogus';
  let before = f.writes;
  assert.deepEqual(await f.run({ action: 'get', actorId: 'admin', jobId: p.jobId }), {
    ok: false,
    code: 'CORRUPT',
  });
  assert.equal(f.writes, before);
  job.state = 'queued';
  job.leaseVersion = Number.MAX_SAFE_INTEGER;
  const call = await f.call(p.jobId);
  before = f.writes;
  assert.deepEqual(await f.run({ action: 'claim', call, owner: 'worker' }), {
    ok: false,
    code: 'CORRUPT',
  });
  assert.equal(f.writes, before);
});

for (const [collection, change] of [
  ['alibabaSourceProducts', { sourceTitle: 'New source title' }],
  ['alibabaProductLinks', { productId: 'other-product' }],
] as const)
  test(`changed ${collection} invalidates service writes even without a product edit`, async () => {
    const f = fixture();
    Object.assign(f.records['products/p'] ?? {}, { alibabaPrimarySourceKey: 'source' });
    f.records[`${collection}/source`] = { _id: 'source' };
    const p = await f.start();
    const r = await f.claim(p.jobId);
    Object.assign(f.records[`${collection}/source`] ?? {}, change);
    assert.deepEqual(await f.run({ action: 'release', jobId: p.jobId, lease: r.lease }), {
      ok: false,
      code: 'STALE',
    });
  });
for (const state of ['cancelled', 'stale', 'blocked', 'completed', 'retryable'])
  test(`dispatch does not automatically restart ${state}`, async () => {
    const f = fixture();
    const p = await f.start();
    const job = f.records[`catalogPreparationJobs/${p.jobId}`];
    assert.ok(job);
    job.state = state;
    assert.deepEqual(await f.run({ action: 'dispatch', actorId: 'admin', jobId: p.jobId }), {
      ok: false,
      code: 'CONFLICT',
    });
    assert.equal((await f.start()).state, state);
  });
for (const change of [
  { productId: 'other' },
  { inputDigest: 'f'.repeat(64) },
  { contentGeneration: 4 },
  { createdAt: '2026-10-16T00:00:00.000Z' },
  { updatedAt: '2026-10-16T00:00:00.000Z' },
  { createdAt: '2026-10-15T00:00:00Z' },
  { attempt: 1 },
  { nonce: 'bad' },
])
  test(`corrupt stored identity/time rejects start and get: ${Object.keys(change)[0]}`, async () => {
    const f = fixture();
    const p = await f.start();
    const job = f.records[`catalogPreparationJobs/${p.jobId}`];
    assert.ok(job);
    Object.assign(job, change);
    const before = f.writes;
    assert.deepEqual(await f.run({ action: 'get', actorId: 'admin', jobId: p.jobId }), {
      ok: false,
      code: 'CORRUPT',
    });
    assert.deepEqual(await f.run({ action: 'start', actorId: 'admin', productId: 'p' }), {
      ok: false,
      code: 'CORRUPT',
    });
    assert.equal(f.writes, before);
  });
test('corrupt generation is a data repair issue rather than a missing product', async () => {
  const f = fixture();
  Object.assign(f.records['products/p'] ?? {}, { catalogContentGeneration: -1 });
  assert.deepEqual(await f.run({ action: 'start', actorId: 'admin', productId: 'p' }), {
    ok: false,
    code: 'CORRUPT',
  });
  assert.equal(f.writes, 0);
});

test('small backwards clock skew cannot persist an invalid updatedAt before createdAt', async () => {
  const f = fixture();
  const p = await f.start();
  f.now -= 1000;
  const r = await f.claim(p.jobId);
  const job = f.records[`catalogPreparationJobs/${p.jobId}`];
  assert.ok(job);
  assert.equal(job.updatedAt, job.createdAt);
  assert.ok((await f.run({ action: 'get', actorId: 'admin', jobId: p.jobId })).ok);
  assert.equal(r.progress.state, 'running');
});
for (const value of ['invalid', '2026-99-99T00:00:00.000Z', '2026-10-15T25:00:00.000Z'])
  test(`malformed timestamp fails closed without throwing: ${value}`, async () => {
    const f = fixture();
    const p = await f.start();
    const job = f.records[`catalogPreparationJobs/${p.jobId}`];
    assert.ok(job);
    job.updatedAt = value;
    assert.deepEqual(await f.run({ action: 'get', actorId: 'admin', jobId: p.jobId }), {
      ok: false,
      code: 'CORRUPT',
    });
  });

for (const action of ['renew', 'release', 'claim'] as const)
  test(`lease expiry during input reads cannot authorize a late ${action}`, async () => {
    const f = fixture();
    const p = await f.start();
    const r = await f.claim(p.jobId);
    if (action === 'claim') f.now += 120001;
    const command =
      action === 'claim'
        ? { action, call: await f.call(p.jobId), owner: 'replacement' }
        : { action, jobId: p.jobId, lease: r.lease };
    const before = f.writes;
    const tx = {
      ...f.tx,
      get: async (collection: string, id: string) => {
        const row = await f.tx.get(collection, id);
        if (collection === 'products') f.now += 120001;
        return row;
      },
    };
    assert.deepEqual(await runCatalogPreparationJob(tx, f.authority, command, f.now), {
      ok: false,
      code: 'CONFLICT',
    });
    assert.equal(f.writes, before);
  });

test('forged lease is rejected before expensive product and source lookups', async () => {
  const f = fixture();
  const p = await f.start();
  await f.claim(p.jobId);
  let productReads = 0;
  const tx = {
    ...f.tx,
    get: async (collection: string, id: string) => {
      if (collection === 'products') productReads++;
      return f.tx.get(collection, id);
    },
  };
  assert.deepEqual(
    await runCatalogPreparationJob(
      tx,
      f.authority,
      { action: 'renew', jobId: p.jobId, lease: {} },
      f.now,
    ),
    { ok: false, code: 'CONFLICT' },
  );
  assert.equal(productReads, 0);
});

test('requested check is projected on product without changing any business field', async () => {
  const f = fixture();
  const before = structuredClone(f.records['products/p']);
  const started = await f.start();
  const product = f.records['products/p'];
  const job = f.records[`catalogPreparationJobs/${started.jobId}`];
  assert.ok(product && job);
  assert.equal(product.catalogPreparationState, 'checking');
  assert.equal(product.catalogPreparationPolicy, CATALOG_PREPARATION_POLICY);
  assert.deepEqual(product.catalogPreparationRequest, {
    schemaVersion: 'catalog-preparation-request-v1',
    productId: 'p',
    jobId: started.jobId,
    inputDigest: job.inputDigest,
    contentGeneration: 3,
    policyVersion: CATALOG_PREPARATION_POLICY,
    requestedAt: job.updatedAt,
  });
  const business = Object.fromEntries(
    Object.entries(product).filter(
      ([key]) =>
        ![
          'catalogPreparationState',
          'catalogPreparationPolicy',
          'catalogPreparationRequest',
        ].includes(key),
    ),
  );
  assert.deepEqual(business, before);
  const projected = structuredClone(product);
  const writes = f.writes;
  assert.deepEqual(await f.start(), started);
  assert.equal(f.writes, writes);
  assert.deepEqual(f.records['products/p'], projected);
  assert.equal(Object.hasOwn(job, 'product'), false);
});

test('explicit start repairs a legacy active job missing its product request', async () => {
  const f = fixture();
  const started = await f.start();
  const product = f.records['products/p'];
  assert.ok(product);
  for (const key of [
    'catalogPreparationState',
    'catalogPreparationPolicy',
    'catalogPreparationRequest',
  ])
    Reflect.deleteProperty(product, key);
  await f.start();
  assert.equal(f.records['products/p']?.catalogPreparationState, 'checking');
  assert.equal(
    CatalogPreparationRequestSchema.parse(f.records['products/p']?.catalogPreparationRequest).jobId,
    started.jobId,
  );
});

test('cancel retires a current checking request and explicit retry requests the same input again', async () => {
  const f = fixture();
  const started = await f.start();
  assert.equal(f.records['products/p']?.catalogPreparationState, 'checking');
  f.now += 1000;
  assert.ok(
    (
      await f.run({
        action: 'cancel',
        actorId: 'admin',
        jobId: started.jobId,
        expectedLeaseVersion: 0,
      })
    ).ok,
  );
  assert.equal(f.records['products/p']?.catalogPreparationState, 'stale');
  f.now += 1000;
  assert.ok(
    (
      await f.run({
        action: 'retry',
        actorId: 'admin',
        jobId: started.jobId,
        expectedLeaseVersion: 0,
      })
    ).ok,
  );
  assert.equal(f.records['products/p']?.catalogPreparationState, 'checking');
  assert.equal(
    CatalogPreparationRequestSchema.parse(f.records['products/p']?.catalogPreparationRequest)
      .requestedAt,
    new Date(f.now).toISOString(),
  );
  assert.equal(f.records['products/p']?.published, false);
  assert.equal(f.records['products/p']?.catalogContentGeneration, 3);
});

test('a late old cancellation cannot clear the newer input requested check', async () => {
  const f = fixture();
  const old = await f.start();
  const product = f.records['products/p'];
  assert.ok(product);
  Object.assign(product, {
    name: 'Edited clock',
    catalogContentGeneration: 4,
    catalogPreparationState: 'stale',
  });
  f.now += 1000;
  const current = await f.start();
  assert.notEqual(current.jobId, old.jobId);
  assert.equal(f.records['products/p']?.catalogPreparationState, 'checking');
  const before = structuredClone(f.records['products/p']);
  assert.ok(
    (await f.run({ action: 'cancel', actorId: 'admin', jobId: old.jobId, expectedLeaseVersion: 0 }))
      .ok,
  );
  assert.deepEqual(f.records['products/p'], before);
});

test('request projection belongs to the protected write layer', () => {
  assert.equal(isCatalogProductManagedField('catalogPreparationRequest'), true);
});

for (const state of ['preparing', 'blocked'] as const)
  test(`start preserves current ${state} checkpoint instead of replacing it with checking`, async () => {
    const f = fixture();
    const started = await f.start();
    await f.claim(started.jobId);
    const job = f.records[`catalogPreparationJobs/${started.jobId}`];
    const product = f.records['products/p'];
    assert.ok(job && product);
    const report = {
      schemaVersion: 'catalog-preparation-report-v2',
      productId: 'p',
      inputDigest: job.inputDigest,
      contentGeneration: 3,
      policyVersion: CATALOG_PREPARATION_POLICY,
      checkedAt: new Date(f.now).toISOString(),
      state,
      previewReady: state === 'preparing',
      mediaReady: false,
      issues:
        state === 'blocked'
          ? [
              {
                code: 'INVALID_VALUE',
                stage: 'effective-content',
                path: 'name',
                severity: 'error',
                remedy: 'edit',
              },
            ]
          : [],
    };
    Object.assign(product, { catalogPreparationState: state, catalogPreparationReport: report });
    const before = structuredClone(product);
    const writes = f.writes;
    assert.equal((await f.start()).state, 'running');
    assert.equal(f.writes, writes);
    assert.deepEqual(f.records['products/p'], before);
  });

test('ordinary product mutations preserve the managed request but invalidate it after an edit', async () => {
  const f = fixture();
  await f.start();
  const product = f.records['products/p'];
  assert.ok(product);
  const request = CatalogPreparationRequestSchema.parse(product.catalogPreparationRequest);
  const saved = advanceCatalogProduct(
    product,
    {
      ...product,
      name: 'Edited',
      catalogPreparationRequest: { ...request, jobId: 'f'.repeat(64) },
    },
    new Date(f.now + 1000).toISOString(),
  );
  assert.deepEqual(saved.catalogPreparationRequest, request);
  assert.equal(saved.catalogPreparationState, 'stale');
  assert.equal(saved.catalogContentGeneration, 4);
  assert.equal(saved.published, false);
});
