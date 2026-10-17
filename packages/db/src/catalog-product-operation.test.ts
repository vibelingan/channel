import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { runStagedApproval } from './catalog-detail-staging.ts';
import { normalizedSourceInputDigest, sourceInputDigest } from './catalog-source-inputs.ts';

const at = '2026-10-18T00:00:00.000Z';
const uuid = '12345678-1234-4234-8234-123456789012';
const jobId = createHash('sha256')
  .update(JSON.stringify(['admin', 'p', uuid]))
  .digest('hex');
const request = (extra: Record<string, unknown> = {}) => ({
  action: 'operation-start',
  productId: 'p',
  operationId: uuid,
  intent: 'publish',
  expectedUpdatedAt: at,
  values: {},
  ...extra,
});
const query = { action: 'operation-get', productId: 'p', operationId: uuid };
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}
function stored(result: unknown) {
  const response = object(result);
  assert.equal(response.ok, true, JSON.stringify(response));
  return object(response.record);
}
function fixture(extra: Record<string, unknown> = {}) {
  let rows: Record<string, CollectionDoc[]> = {
    users: [
      { _id: 'admin', role: 'admin' },
      { _id: 'other', role: 'admin' },
      { _id: 'guest', role: 'member' },
    ],
    products: [
      {
        _id: 'p',
        name: 'Clock',
        description: '',
        published: false,
        archived: false,
        productFamily: 'misc',
        imageIds: [],
        updatedAt: at,
        ...extra,
      },
    ],
  };
  let failWrite = false;
  let writes = 0;
  let reads = 0;
  let userGate: Promise<void> | undefined;
  const invoke = async (input: unknown, actor = 'admin'): Promise<unknown> => {
    const copy = structuredClone(rows);
    const result: unknown = await Reflect.apply(runStagedApproval, undefined, [
      {
        get: async (collection: string, id: string) => {
          reads++;
          if (collection === 'users' && userGate) await userGate;
          return structuredClone(copy[collection]?.find((row) => row._id === id) ?? null);
        },
        set: async (collection: string, row: CollectionDoc) => {
          writes++;
          if (failWrite) throw new Error('owned reservation write failed');
          copy[collection] ??= [];
          const list = copy[collection];
          const index = list.findIndex((entry) => entry._id === row._id);
          if (index < 0) list.push(structuredClone(row));
          else list[index] = structuredClone(row);
        },
      },
      actor,
      input,
    ]);
    // A native transaction commits even when the callback returns a domain error.
    // Only thrown writes roll back, so early false results must not have written.
    rows = copy;
    return result;
  };
  return {
    invoke,
    row: (collection: string, id: string) => rows[collection]?.find((r) => r._id === id),
    snapshot: () => JSON.stringify(rows),
    counts: () => ({ reads, writes }),
    holdUser: () => {
      let release = () => {};
      userGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    fail: (value = true) => {
      failWrite = value;
    },
    put: (collection: string, row: CollectionDoc) => {
      rows[collection] ??= [];
      rows[collection].push(row);
    },
  };
}

test('operation reservation persists the reviewed base without changing the product', async () => {
  const h = fixture();
  const before = JSON.stringify(h.row('products', 'p'));
  const row = stored(await h.invoke(request({ values: { description: 'Reviewed text' } })));
  assert.equal(row._id, jobId);
  assert.equal(row.state, 'reserved');
  assert.equal(row.actorId, 'admin');
  assert.equal(row.productId, 'p');
  assert.equal(row.operationId, uuid);
  const input = object(row.operation);
  assert.equal(input.protocolVersion, 2);
  assert.equal(input.intent, 'publish');
  assert.equal(input.expectedUpdatedAt, at);
  assert.deepEqual(input.values, { description: 'Reviewed text' });
  assert.match(String(input.inputDigest), /^[a-f0-9]{64}$/);
  const base = object(input.base);
  assert.equal(base.contentGeneration, 0);
  assert.equal(base.lifecycleVersion, 0);
  assert.equal(base.classificationRevision, 0);
  assert.equal(JSON.stringify(h.row('products', 'p')), before);
  assert.equal(object(await h.invoke(query)).current, true);
  assert.equal(h.counts().writes, 1);
  assert.ok(h.counts().reads <= 6);
});
test('operation identical start and get reuse the same persistent receipt with zero extra writes', async () => {
  const h = fixture();
  const first = stored(await h.invoke(request()));
  const bytes = h.snapshot();
  assert.deepEqual(stored(await h.invoke(request())), first);
  assert.deepEqual(stored(await h.invoke(query)), first);
  assert.equal(h.snapshot(), bytes);
  assert.equal(h.counts().writes, 1);
});
for (const extra of [
  { intent: 'unpublish' },
  { expectedUpdatedAt: '2026-10-18T00:00:01.000Z' },
  { values: { description: 'Different reviewed patch' } },
])
  test(`operation ID cannot be rebound to changed input ${JSON.stringify(extra)}`, async () => {
    const h = fixture();
    stored(await h.invoke(request()));
    const bytes = h.snapshot();
    assert.deepEqual(await h.invoke(request(extra)), { ok: false, code: 'CONFLICT' });
    assert.equal(h.snapshot(), bytes);
    assert.equal(h.counts().writes, 1);
  });
test('operation patch key order does not create a different request identity', async () => {
  const h = fixture();
  const a = stored(await h.invoke(request({ values: { name: 'New clock', description: 'Text' } })));
  const b = stored(await h.invoke(request({ values: { description: 'Text', name: 'New clock' } })));
  assert.deepEqual(a, b);
  assert.equal(h.counts().writes, 1);
});
for (const change of [
  { description: 'Another operator edited' },
  { published: true, catalogLifecycleVersion: 1 },
  { published: false, catalogLifecycleVersion: 1 },
  { catalogContentGeneration: 1 },
  { catalogClassificationRevision: 1 },
  { subcategoryIds: ['other'] },
])
  test(`operation get reports a changed input without rewriting its base ${JSON.stringify(change)}`, async () => {
    const h = fixture();
    const original = stored(await h.invoke(request()));
    const product = h.row('products', 'p');
    assert.ok(product);
    Object.assign(product, change);
    const bytes = h.snapshot();
    const answer = object(await h.invoke(query));
    assert.equal(answer.current, false);
    assert.deepEqual(answer.record, original);
    assert.equal(h.snapshot(), bytes);
    assert.equal(h.counts().writes, 1);
  });
test('operation capture-only timestamps do not invalidate the reviewed website inputs', async () => {
  const h = fixture();
  stored(await h.invoke(request()));
  const product = h.row('products', 'p');
  assert.ok(product);
  product.alibabaLastSeenAt = '2026-10-18T00:01:00.000Z';
  product.updatedAt = '2026-10-18T00:01:00.000Z';
  assert.equal(object(await h.invoke(query)).current, true);
  assert.equal(h.counts().writes, 1);
});
for (const key of [
  'catalogContentGeneration',
  'catalogLifecycleVersion',
  'catalogClassificationRevision',
])
  for (const invalid of [-1, 1.5, '1'])
    test(`operation refuses corrupt stored ${key}=${invalid}`, async () => {
      const h = fixture({ [key]: invalid });
      const bytes = h.snapshot();
      const answer = object(await h.invoke(request()));
      assert.equal(answer.ok, false);
      assert.equal(answer.code, 'CONFLICT');
      assert.equal(h.snapshot(), bytes);
      assert.equal(h.counts().writes, 0);
    });
test('operation stale selection is refused before reservation', async () => {
  const h = fixture({ updatedAt: '2026-10-18T00:00:01.000Z' });
  const bytes = h.snapshot();
  assert.deepEqual(await h.invoke(request()), { ok: false, code: 'CONFLICT' });
  assert.equal(h.snapshot(), bytes);
  assert.equal(h.counts().writes, 0);
});
test('operation legacy null revision and counters can reserve a withdrawal despite broken source', async () => {
  const h = fixture({
    updatedAt: undefined,
    catalogContentGeneration: null,
    catalogLifecycleVersion: null,
    catalogClassificationRevision: null,
    alibabaPrimarySourceKey: 'missing-source',
  });
  const before = JSON.stringify(h.row('products', 'p'));
  const row = stored(await h.invoke(request({ intent: 'unpublish', expectedUpdatedAt: null })));
  assert.equal(object(row.operation).expectedUpdatedAt, null);
  assert.equal(JSON.stringify(h.row('products', 'p')), before);
  assert.equal(h.counts().reads, 3);
  assert.equal(h.counts().writes, 1);
});
test('operation cannot inspect another actor or product using a known UUID', async () => {
  const h = fixture();
  stored(await h.invoke(request()));
  const bytes = h.snapshot();
  assert.deepEqual(await h.invoke(query, 'other'), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await h.invoke({ ...query, productId: 'other-product' }), {
    ok: false,
    code: 'NOT_FOUND',
  });
  assert.equal(h.snapshot(), bytes);
});
test('operation access rechecks the current role for start and query', async () => {
  const h = fixture();
  assert.deepEqual(await h.invoke(request(), 'guest'), { ok: false, code: 'FORBIDDEN' });
  stored(await h.invoke(request()));
  const actor = h.row('users', 'admin');
  assert.ok(actor);
  actor.role = 'member';
  const bytes = h.snapshot();
  assert.deepEqual(await h.invoke(query), { ok: false, code: 'FORBIDDEN' });
  assert.equal(h.snapshot(), bytes);
});
test('operation never overwrites a historical approval at the same deterministic ID', async () => {
  const h = fixture();
  h.put('catalogDetailApprovals', {
    _id: jobId,
    actorId: 'admin',
    operationId: uuid,
    productId: 'p',
    state: 'complete',
    revision: 'legacy-approval',
  });
  const bytes = h.snapshot();
  assert.deepEqual(await h.invoke(request()), { ok: false, code: 'CONFLICT' });
  assert.equal(h.snapshot(), bytes);
  assert.equal(h.counts().writes, 0);
});
test('operation reservation write failure rolls back and the same ID can be retried', async () => {
  const h = fixture();
  const bytes = h.snapshot();
  h.fail();
  await assert.rejects(h.invoke(request()), /reservation write failed/);
  assert.equal(h.snapshot(), bytes);
  h.fail(false);
  assert.equal(stored(await h.invoke(request()))._id, jobId);
});
for (const values of [
  { published: true },
  { archived: true },
  { catalogLifecycleVersion: 42 },
  { description: 'x'.repeat(300000) },
  { unitPrice: Number.POSITIVE_INFINITY },
])
  test(`operation refuses invalid or oversized patch ${Object.keys(values)[0]}`, async () => {
    const h = fixture();
    const bytes = h.snapshot();
    const answer = object(await h.invoke(request({ values })));
    assert.equal(answer.ok, false);
    assert.equal(answer.code, 'VALIDATION_ERROR');
    assert.equal(h.snapshot(), bytes);
    assert.equal(h.counts().writes, 0);
  });
test('operation returned record mutations cannot change the durable receipt', async () => {
  const h = fixture();
  const row = stored(await h.invoke(request({ values: { description: 'Original' } })));
  const bytes = h.snapshot();
  const input = object(row.operation);
  const values = object(input.values);
  values.description = 'Caller changed';
  input.intent = 'archive';
  row.state = 'complete';
  assert.equal(h.snapshot(), bytes);
  assert.equal(stored(await h.invoke(query)).state, 'reserved');
});
test('existing finish missing-job and role guards remain usable controls', async () => {
  const h = fixture();
  const command = { action: 'finish', jobId: 'a'.repeat(64) };
  assert.deepEqual(await h.invoke(command), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await h.invoke(command, 'guest'), { ok: false, code: 'FORBIDDEN' });
  assert.equal(h.counts().writes, 0);
});

function linked() {
  const h = fixture({ alibabaPrimarySourceKey: 's' });
  h.put('alibabaSourceProducts', {
    _id: 's',
    sourceKey: 's',
    connectionId: 'c',
    sourceProductId: 'ext',
    sourceCategoryId: '100',
    contentHash: 'a'.repeat(64),
    active: true,
  });
  h.put('catalogSourceObservations', {
    _id: sourceObservationDocumentId('alibaba', 's'),
    sourceContentHash: 'a'.repeat(64),
    observation: {
      source: {
        provider: 'alibaba',
        sourceProductKey: 's',
        externalProductId: 'ext',
        observedAt: at,
      },
      attributes: [{ name: 'Size', value: '10' }],
    },
  });
  h.put('alibabaProductLinks', {
    _id: 's',
    sourceKey: 's',
    connectionId: 'c',
    sourceProductId: 'ext',
    productId: 'p',
    linkedAt: at,
  });
  return h;
}
for (const collection of [
  'alibabaSourceProducts',
  'catalogSourceObservations',
  'alibabaProductLinks',
])
  test(`operation publication base includes ${collection} rather than only the product row`, async () => {
    const h = linked();
    const original = stored(await h.invoke(request()));
    const row = h.row(
      collection,
      collection === 'catalogSourceObservations'
        ? sourceObservationDocumentId('alibaba', 's')
        : 's',
    );
    assert.ok(row);
    if (collection === 'alibabaSourceProducts') row.sourceCategoryId = '200';
    else if (collection === 'catalogSourceObservations')
      object(row.observation).attributes = [{ name: 'Size', value: '20' }];
    else row.productId = 'another-product';
    const bytes = h.snapshot();
    const answer = object(await h.invoke(query));
    assert.equal(answer.current, false);
    assert.deepEqual(answer.record, original);
    assert.equal(h.snapshot(), bytes);
    assert.equal(h.counts().writes, 1);
  });
test('operation ignores source/link capture metadata while preserving meaningful source hashes', async () => {
  const h = linked();
  stored(await h.invoke(request()));
  const source = h.row('alibabaSourceProducts', 's');
  const link = h.row('alibabaProductLinks', 's');
  const observation = h.row(
    'catalogSourceObservations',
    sourceObservationDocumentId('alibaba', 's'),
  );
  assert.ok(source && link && observation);
  source.updatedAt = 'later';
  link.updatedAt = 'later';
  observation.evidenceId = 'new-same-business-capture';
  object(object(observation.observation).source).observedAt = '2026-10-18T00:01:00.000Z';
  assert.equal(object(await h.invoke(query)).current, true);
  assert.equal(h.counts().writes, 1);
});
test('operation get exposes expiry without repairing or deleting the original record', async () => {
  const h = fixture();
  stored(await h.invoke(request()));
  const row = h.row('catalogDetailApprovals', jobId);
  assert.ok(row);
  row.createdAt = '2000-01-01T00:00:00.000Z';
  const bytes = h.snapshot();
  assert.equal(object(await h.invoke(query)).expired, true);
  assert.equal(h.snapshot(), bytes);
  assert.equal(h.counts().writes, 1);
});
test('operation cyclic or excessively deep JSON is rejected without hash recursion', async () => {
  const h = fixture();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const answer = object(await h.invoke(request({ values: { imageIds: cycle } })));
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'VALIDATION_ERROR');
  assert.equal(h.counts().writes, 0);
});

test('operation freezes nested JSON input before awaiting storage', async () => {
  const h = fixture();
  const release = h.holdUser();
  const imageIds = ['reviewed-image'];
  const pending = h.invoke(request({ values: { imageIds } }));
  imageIds[0] = 'another-operation-image';
  release();
  const row = stored(await pending);
  assert.deepEqual(object(row.operation).values, { imageIds: ['reviewed-image'] });
});
for (const corruption of ['future-version', 'different-patch', 'complete-state'])
  test(`operation get refuses a corrupt stored reservation: ${corruption}`, async () => {
    const h = fixture();
    stored(await h.invoke(request()));
    const row = h.row('catalogDetailApprovals', jobId);
    assert.ok(row);
    if (corruption === 'future-version') object(row.operation).protocolVersion = 999;
    else if (corruption === 'different-patch')
      object(row.operation).values = { description: 'Tampered input' };
    else row.state = 'complete';
    const bytes = h.snapshot();
    assert.deepEqual(await h.invoke(query), { ok: false, code: 'CONFLICT' });
    assert.equal(h.snapshot(), bytes);
    assert.equal(h.counts().writes, 1);
  });
test('operation budget measures UTF-8 bytes and preserves a legal 30000-character description', async () => {
  const h = fixture();
  assert.deepEqual(await h.invoke(request({ values: { description: '中'.repeat(100000) } })), {
    ok: false,
    code: 'VALIDATION_ERROR',
  });
  assert.equal(h.counts().writes, 0);
  const row = stored(await h.invoke(request({ values: { description: '中'.repeat(30000) } })));
  assert.equal(String(object(object(row.operation).values).description).length, 30000);
});
for (const pair of [
  { intent: 'publish', product: { archived: true } },
  { intent: 'refresh-live', product: { published: false } },
])
  test(`operation rejects an incompatible ${pair.intent} visibility intent`, async () => {
    const h = fixture(pair.product);
    const bytes = h.snapshot();
    assert.deepEqual(await h.invoke(request({ intent: pair.intent })), {
      ok: false,
      code: 'CONFLICT',
    });
    assert.equal(h.snapshot(), bytes);
    assert.equal(h.counts().writes, 0);
  });

for (const extra of ['date', 'deep', 'wide'] as const)
  test(`operation source snapshot ignores unused capture metadata: ${extra}`, async () => {
    const h = linked();
    const source = h.row('alibabaSourceProducts', 's');
    const observation = h.row(
      'catalogSourceObservations',
      sourceObservationDocumentId('alibaba', 's'),
    );
    const link = h.row('alibabaProductLinks', 's');
    assert.ok(source && observation && link);
    let metadata: unknown =
      extra === 'date' ? new Date(at) : extra === 'wide' ? 'x'.repeat(2100000) : 'leaf';
    if (extra === 'deep') for (let i = 0; i < 64; i++) metadata = { capture: metadata };
    source.privateCaptureArchive = metadata;
    link.privateCaptureArchive = metadata;
    object(observation.observation).evidence = { privateCaptureArchive: metadata };
    const row = stored(await h.invoke(request()));
    assert.ok(
      Buffer.byteLength(JSON.stringify(row)) < 4096,
      'operation stores hashes, not the source cache',
    );
    assert.equal(object(await h.invoke(query)).current, true);
    assert.equal(h.counts().writes, 1);
  });

const hashFixtures: Array<{
  source: CollectionDoc | null;
  observation: CollectionDoc | null;
  sourceHash: string;
  observationHash: string;
}> = [
  {
    source: null,
    observation: null,
    sourceHash: '17235b216334245499e8c5ba96a5854d59870ab8c07c5e2bbc3e534f9e760ee1',
    observationHash: '3c6237eb877ded367ff0b420a0121bd2c3d8ed311e1d090a85f777b759aa7c57',
  },
  {
    source: {
      _id: 's',
      sourceKey: 's',
      connectionId: 'c',
      sourceProductId: 'external',
      sourceTitle: 'Clock',
      sourceDescription: 'Reviewed',
      sourceCategoryId: '10',
      sourceCategoryPath: ['Home', 'Clock'],
      sourceImageUrls: ['https://example.test/a.png'],
      active: true,
      contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      privateCaptureArchive: 'ignored',
    },
    observation: {
      _id: 'obs',
      active: true,
      sourceContentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidenceId: 'unused-with-content-hash',
      observation: {
        source: {
          provider: 'alibaba',
          externalProductId: 'external',
          sourceProductKey: 's',
          observedAt: '2026-10-18T00:00:00.000Z',
        },
        identity: { title: 'Clock' },
        attributes: [{ name: 'Size', value: '10' }],
        evidence: { private: true },
      },
    },
    sourceHash: '6dc6818750533aac10d226612fddb155d8607fa1c26759e8adb3fba11dc16376',
    observationHash: 'b74168cde3e2b5ea6d68c038b6e3a763f87c951ffa44615ae42b71ef89ee034e',
  },
];
for (const [index, fixture] of hashFixtures.entries())
  test(`source input digest remains compatible with the pre-reservation hash: ${index}`, () => {
    assert.equal(normalizedSourceInputDigest(fixture.source), fixture.sourceHash);
    assert.equal(sourceInputDigest(fixture.observation), fixture.observationHash);
  });
