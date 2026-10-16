import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CATALOG_PREPARATION_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
import type { DbAdapter } from './adapter.ts';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import {
  catalogPreparationImageHold,
  findCatalogPreparationImageHold,
} from './catalog-preparation-image-hold.ts';
import { readCatalogPreparationJob, runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import { catalogPreparationInputDigest } from './catalog-preparation-store.ts';
function fixture() {
  let now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'hold-test-secret',
    environmentId: 'test',
    now: () => now,
  });
  const rows: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': { _id: 'p', name: 'Clock', catalogContentGeneration: 3, published: false },
  };
  const writes: string[] = [];
  const tx = {
    get: async (c: string, id: string) => structuredClone(rows[`${c}/${id}`] ?? null),
    set: async (c: string, row: CollectionDoc) => {
      writes.push(`${c}/${row._id}`);
      rows[`${c}/${row._id}`] = structuredClone(row);
    },
  };
  const run = (command: unknown) => runCatalogPreparationJob(tx, authority, command, now);
  async function claimed() {
    const start = await run({ action: 'start', actorId: 'admin', productId: 'p' });
    assert.ok(start.ok && 'progress' in start);
    const jobId = start.progress.jobId;
    const d = await run({ action: 'dispatch', actorId: 'admin', jobId });
    assert.ok(d.ok && 'call' in d);
    const claim = await run({ action: 'claim', call: d.call, owner: 'worker' });
    assert.ok(claim.ok && 'lease' in claim);
    return { jobId, lease: claim.lease };
  }
  return {
    rows,
    writes,
    tx,
    authority,
    run,
    claimed,
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
  };
}
test('a current lease reserves a source-only image before any image/object read, without product mutations', async () => {
  const h = fixture();
  const scope = await h.claimed();
  const before = structuredClone(h.rows['products/p']);
  h.writes.length = 0;
  const result = await h.run({ action: 'reserve-image-check', ...scope, imageId: 'source-only' });
  assert.deepEqual(result, { ok: true, reservation: 'reserved' });
  assert.equal(h.writes.length, 2);
  const held = Object.values(h.rows).filter((r) => r.kind === 'catalog-preparation-image-hold-v1');
  assert.equal(held.length, 1);
  assert.equal(held[0]?.imageId, 'source-only');
  assert.equal(held[0]?.jobId, scope.jobId);
  assert.deepEqual(h.rows['products/p'], before);
});
test('lost acknowledgement replay keeps one identical hold and fences the same job', async () => {
  const h = fixture();
  const scope = await h.claimed();
  const command = { action: 'reserve-image-check', ...scope, imageId: 'source-only' };
  assert.ok((await h.run(command)).ok);
  const held = structuredClone(
    Object.values(h.rows).filter((r) => r.kind === 'catalog-preparation-image-hold-v1'),
  );
  h.writes.length = 0;
  assert.ok((await h.run(command)).ok);
  assert.deepEqual(
    Object.values(h.rows).filter((r) => r.kind === 'catalog-preparation-image-hold-v1'),
    held,
  );
  assert.equal(h.writes.length, 1);
});
test('forged and expired leases cannot reserve an image', async () => {
  const h = fixture();
  const scope = await h.claimed();
  h.writes.length = 0;
  assert.deepEqual(
    await h.run({ action: 'reserve-image-check', ...scope, lease: {}, imageId: 'image' }),
    { ok: false, code: 'CONFLICT' },
  );
  h.now += 120001;
  assert.deepEqual(await h.run({ action: 'reserve-image-check', ...scope, imageId: 'image' }), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(h.writes.length, 0);
});
test('content change refuses the old reservation and marks only the old job stale', async () => {
  const h = fixture();
  const scope = await h.claimed();
  Object.assign(h.rows['products/p'] ?? {}, { name: 'Changed' });
  h.writes.length = 0;
  assert.deepEqual(await h.run({ action: 'reserve-image-check', ...scope, imageId: 'image' }), {
    ok: false,
    code: 'STALE',
  });
  assert.equal(h.writes.length, 1);
  assert.equal(h.rows[`catalogPreparationJobs/${scope.jobId}`]?.state, 'stale');
  assert.equal(
    Object.values(h.rows).some((r) => r.kind === 'catalog-preparation-image-hold-v1'),
    false,
  );
});
function reader(h: ReturnType<typeof fixture>) {
  let queries = 0;
  const list: DbAdapter['list'] = async (q) => {
    queries++;
    assert.equal(q.collection, 'catalogImageObservations');
    assert.equal(q.page, 1);
    assert.equal(q.pageSize, 100);
    let items = Object.entries(h.rows)
      .filter(([key]) => key.startsWith('catalogImageObservations/'))
      .map(([, r]) => structuredClone(r));
    for (const c of q.filter?.clauses ?? [])
      items = items.filter((r) =>
        c.op === 'eq'
          ? r[c.field] === c.value
          : c.op === 'gt'
            ? String(r[c.field]) > String(c.value)
            : false,
      );
    items.sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
    return { items: items.slice(0, 100), total: items.length, page: 1, pageSize: 100 };
  };
  return {
    get: h.tx.get,
    list,
    get queries() {
      return queries;
    },
  };
}
async function reserved() {
  const h = fixture();
  const scope = await h.claimed();
  assert.ok((await h.run({ action: 'reserve-image-check', ...scope, imageId: 'image' })).ok);
  return { ...h, scope };
}
for (const state of ['queued', 'running', 'retryable', 'blocked'] as const)
  test(`current ${state} preparation holds source-only bytes without a time-based release`, async () => {
    const h = await reserved();
    const job = h.rows[`catalogPreparationJobs/${h.scope.jobId}`];
    assert.ok(job);
    if (state !== 'running') Object.assign(job, { state, leaseOwner: '', leaseExpiresAt: 0 });
    const before = structuredClone(h.rows);
    assert.equal(
      await findCatalogPreparationImageHold(
        reader(h),
        'image',
        h.now + 3600000,
        readCatalogPreparationJob,
      ),
      'p',
    );
    assert.deepEqual(h.rows, before);
  });
for (const state of ['cancelled', 'stale'] as const)
  test(`${state} jobs release the deletion hold`, async () => {
    const h = await reserved();
    Object.assign(h.rows[`catalogPreparationJobs/${h.scope.jobId}`] ?? {}, {
      state,
      leaseOwner: '',
      leaseExpiresAt: 0,
    });
    assert.equal(
      await findCatalogPreparationImageHold(reader(h), 'image', h.now, readCatalogPreparationJob),
      null,
    );
  });
test('a completed job protects only its current ready input, without approving or publishing', async () => {
  const h = await reserved();
  const job = h.rows[`catalogPreparationJobs/${h.scope.jobId}`];
  const product = h.rows['products/p'];
  assert.ok(job && product);
  Object.assign(job, { state: 'completed', leaseOwner: '', leaseExpiresAt: 0 });
  const r = reader(h);
  assert.equal(
    await findCatalogPreparationImageHold(r, 'image', h.now, readCatalogPreparationJob),
    null,
  );
  const report = {
    schemaVersion: 'catalog-preparation-report-v1',
    productId: 'p',
    inputDigest: catalogPreparationInputDigest({
      product,
      source: null,
      observation: null,
      link: null,
    }),
    policyVersion: CATALOG_PREPARATION_POLICY,
    contentGeneration: 3,
    checkedAt: new Date(h.now).toISOString(),
    state: 'ready',
    previewReady: true,
    mediaReady: true,
    issues: [],
  };
  Object.assign(product, {
    catalogPreparationState: 'ready',
    catalogPreparationPolicy: CATALOG_PREPARATION_POLICY,
    catalogPreparationReport: report,
  });
  assert.equal(
    await findCatalogPreparationImageHold(r, 'image', h.now, readCatalogPreparationJob),
    'p',
  );
  product.catalogPreparationState = 'stale';
  assert.equal(
    await findCatalogPreparationImageHold(r, 'image', h.now, readCatalogPreparationJob),
    null,
  );
  assert.equal(product.published, false);
});
for (const field of [
  'name',
  'catalogContentGeneration',
  'missing-product',
  'missing-job',
  'nonce',
] as const)
  test(`an obsolete ${field} releases its old hold`, async () => {
    const h = await reserved();
    const product = h.rows['products/p'];
    const job = h.rows[`catalogPreparationJobs/${h.scope.jobId}`];
    assert.ok(product && job);
    if (field === 'name') product.name = 'Edited';
    if (field === 'catalogContentGeneration') product.catalogContentGeneration = 4;
    if (field === 'missing-product') Reflect.deleteProperty(h.rows, 'products/p');
    if (field === 'missing-job')
      Reflect.deleteProperty(h.rows, `catalogPreparationJobs/${h.scope.jobId}`);
    if (field === 'nonce') job.nonce = 'a'.repeat(64);
    assert.equal(
      await findCatalogPreparationImageHold(reader(h), 'image', h.now, readCatalogPreparationJob),
      null,
    );
  });
test('strict cursor pagination finds the live hold after more than 100 historical nonces', async () => {
  const h = await reserved();
  const raw = h.rows[`catalogPreparationJobs/${h.scope.jobId}`];
  assert.ok(raw);
  const job = readCatalogPreparationJob(raw, h.scope.jobId, h.now);
  assert.ok(job);
  for (const key of Object.keys(h.rows))
    if (key.startsWith('catalogImageObservations/')) Reflect.deleteProperty(h.rows, key);
  const holds = Array.from({ length: 121 }, (_, i) =>
    catalogPreparationImageHold({ ...job, nonce: i.toString(16).padStart(64, '0') }, 'image'),
  ).sort((a, b) => (a._id < b._id ? -1 : 1));
  for (const hold of holds) h.rows[`catalogImageObservations/${hold._id}`] = hold;
  raw.nonce = holds.at(-1)?.nonce;
  const r = reader(h);
  assert.equal(
    await findCatalogPreparationImageHold(r, 'image', h.now, readCatalogPreparationJob),
    'p',
  );
  assert.equal(r.queries, 2);
});
for (const bad of ['row', 'identity', 'job'] as const)
  test(`malformed matching ${bad} fails closed`, async () => {
    const h = await reserved();
    const hold = Object.values(h.rows).find((r) => r.kind === 'catalog-preparation-image-hold-v1');
    assert.ok(hold);
    if (bad === 'row') hold.extra = true;
    if (bad === 'identity') hold._id = 'f'.repeat(64);
    if (bad === 'job')
      Object.assign(h.rows[`catalogPreparationJobs/${h.scope.jobId}`] ?? {}, { media: 'bad' });
    await assert.rejects(
      findCatalogPreparationImageHold(reader(h), 'image', h.now, readCatalogPreparationJob),
    );
  });
test('a pagination adapter that repeats a full page cannot be mistaken for no dependency', async () => {
  const h = await reserved();
  const hold = Object.values(h.rows).find((r) => r.kind === 'catalog-preparation-image-hold-v1');
  assert.ok(hold);
  Object.assign(h.rows[`catalogPreparationJobs/${h.scope.jobId}`] ?? {}, {
    state: 'cancelled',
    leaseOwner: '',
    leaseExpiresAt: 0,
  });
  const list: DbAdapter['list'] = async () => ({
    items: Array.from({ length: 100 }, () => structuredClone(hold)),
    total: 100,
    page: 1,
    pageSize: 100,
  });
  await assert.rejects(
    findCatalogPreparationImageHold(
      { get: h.tx.get, list },
      'image',
      h.now,
      readCatalogPreparationJob,
    ),
    /cursor/,
  );
});
for (const field of ['source', 'observation', 'link'] as const)
  test(`deletion ignores a hold after its ${field} input changed without a generation edit`, async () => {
    const h = fixture();
    const product = h.rows['products/p'];
    assert.ok(product);
    product.alibabaPrimarySourceKey = 'source';
    h.rows['alibabaSourceProducts/source'] = {
      _id: 'source',
      active: true,
      contentHash: 'a'.repeat(64),
    };
    h.rows['alibabaProductLinks/source'] = { _id: 'source', productId: 'p' };
    const { sourceObservationDocumentId } = await import(
      '@vibelingan-channel/catalog-import/observations'
    );
    const observationKey = `catalogSourceObservations/${sourceObservationDocumentId('alibaba', 'source')}`;
    h.rows[observationKey] = {
      _id: observationKey.split('/')[1] ?? '',
      observation: { identity: { title: 'Before' } },
    };
    const scope = await h.claimed();
    assert.ok((await h.run({ action: 'reserve-image-check', ...scope, imageId: 'image' })).ok);
    const r = reader(h);
    assert.equal(
      await findCatalogPreparationImageHold(r, 'image', h.now, readCatalogPreparationJob),
      'p',
    );
    if (field === 'source')
      Object.assign(h.rows['alibabaSourceProducts/source'] ?? {}, { contentHash: 'b'.repeat(64) });
    if (field === 'observation')
      Object.assign(h.rows[observationKey] ?? {}, {
        observation: { identity: { title: 'After' } },
      });
    if (field === 'link')
      Object.assign(h.rows['alibabaProductLinks/source'] ?? {}, { productId: 'other' });
    assert.equal(
      await findCatalogPreparationImageHold(r, 'image', h.now, readCatalogPreparationJob),
      null,
    );
  });
test('a malformed existing reservation is refused with no write or silent repair', async () => {
  const h = await reserved();
  const hold = Object.values(h.rows).find((r) => r.kind === 'catalog-preparation-image-hold-v1');
  assert.ok(hold);
  hold.productId = 'other';
  h.writes.length = 0;
  assert.deepEqual(await h.run({ action: 'reserve-image-check', ...h.scope, imageId: 'image' }), {
    ok: false,
    code: 'CORRUPT',
  });
  assert.equal(h.writes.length, 0);
});
test('expiry while reading current input cannot create a late reservation', async () => {
  const h = fixture();
  const scope = await h.claimed();
  const get = h.tx.get;
  h.tx.get = async (c, id) => {
    const row = await get(c, id);
    if (c === 'products') h.now += 120001;
    return row;
  };
  h.writes.length = 0;
  assert.deepEqual(await h.run({ action: 'reserve-image-check', ...scope, imageId: 'image' }), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(h.writes.length, 0);
});
