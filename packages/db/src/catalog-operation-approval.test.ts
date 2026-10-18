import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { CATALOG_APPROVAL_JOB_MAX_BYTES } from '@vibelingan-channel/shared/catalog-detail-approval';
import { ApprovalJobSchema, fitsApprovalJobBudget } from './catalog-approval-job.ts';
import { catalogApprovalDigest } from './catalog-detail-commit.ts';
import { prepareStagedApproval, runStagedApproval } from './catalog-detail-staging.ts';
import { productOperationSaveReceipt, runProductOperation } from './catalog-product-operation.ts';

const uuid = '12345678-1234-4234-8234-123456789012';
const query = { action: 'operation-get', productId: 'p', operationId: uuid };
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function fixture(
  intent: 'publish' | 'save-draft' = 'publish',
  saved = true,
  large = false,
  linked = false,
  variantCount = 0,
  extra: Record<string, unknown> = {},
) {
  const product: CollectionDoc = {
    _id: 'p',
    name: 'Clock',
    description: large ? 'd'.repeat(30000) : '',
    productFamily: 'misc',
    published: false,
    archived: false,
    imageIds: [],
    updatedAt: new Date().toISOString(),
    ...(linked ? { alibabaPrimarySourceKey: 's', alibabaLinkRevision: 1 } : {}),
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'r1',
    detailSourceContentGeneration: 0,
    detailSourceManifest: { revision: 'r1', variantIds: [] },
    detailSourceCandidate: {
      _id: 'p',
      schemaVersion: 'catalog-product-detail-v1',
      name: 'Clock',
      images: [],
      facts: large
        ? Array.from({ length: 256 }, (_, i) => ({ name: `F${i}`, value: '中'.repeat(600) }))
        : [],
      offers: [],
    },
  };
  const variants = Array.from({ length: variantCount }, (_, position) => ({
    _id: `v${position}`,
    productId: 'p',
    position,
    sku: `sku-${position}`,
    detailSourceOwner: product.detailSourceOwner,
    detailSourceRevision: 'r1',
    detailSourceMissing: false,
    imageIds: [],
    optionValues: { Color: String(position) },
    detailSourceCandidate: {
      id: `v${position}`,
      options: [],
      images: [],
      offers: [],
      inventory: { state: 'unknown' },
    },
  }));
  product.detailSourceManifest = { revision: 'r1', variantIds: variants.map((row) => row._id) };
  Object.assign(product, extra);
  const rows: Record<string, CollectionDoc[]> = {
    users: [
      { _id: 'admin', role: 'admin' },
      { _id: 'other', role: 'admin' },
      { _id: 'guest', role: 'member' },
    ],
    products: [product],
    catalogDetailApprovals: [],
    productVariants: variants,
    catalogDetailVariants: [],
  };
  if (linked) {
    rows.alibabaSourceProducts = [
      {
        _id: 's',
        sourceKey: 's',
        connectionId: 'c',
        sourceProductId: 'ext',
        contentHash: 'a'.repeat(64),
        active: true,
      },
    ];
    rows.catalogSourceObservations = [
      {
        _id: sourceObservationDocumentId('alibaba', 's'),
        sourceContentHash: 'a'.repeat(64),
        observation: {
          source: {
            provider: 'alibaba',
            sourceProductKey: 's',
            externalProductId: 'ext',
            observedAt: product.updatedAt,
          },
          attributes: [{ name: 'Size', value: '10' }],
        },
      },
    ];
    rows.alibabaProductLinks = [
      {
        _id: 's',
        sourceKey: 's',
        connectionId: 'c',
        sourceProductId: 'ext',
        productId: 'p',
        linkedAt: product.updatedAt,
      },
    ];
  }
  let writes = 0;
  let fail = false;
  const tx = {
    get: async (c: string, id: string) =>
      structuredClone(rows[c]?.find((r) => r._id === id) ?? null),
    set: async (c: string, row: CollectionDoc) => {
      if (fail) throw new Error('unacknowledged owned approval');
      writes++;
      rows[c] ??= [];
      const list = rows[c];
      const i = list.findIndex((r) => r._id === row._id);
      if (i < 0) list.push(structuredClone(row));
      else list[i] = structuredClone(row);
    },
  };
  const start = {
    action: 'operation-start' as const,
    productId: 'p',
    operationId: uuid,
    intent,
    expectedUpdatedAt: product.updatedAt,
    values: { description: product.description },
  };
  const result = await runProductOperation(tx, 'admin', start);
  assert.ok(result.ok && result.record.state === 'reserved');
  if (saved) {
    product.catalogLifecycleVersion = 1;
    const receipt = productOperationSaveReceipt(result.record, product);
    await tx.set('catalogDetailApprovals', receipt);
  }
  const previous = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  const planned = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId: uuid,
      expectedRevision: previous.success ? previous.data.revision : null,
      expectedDigest: catalogApprovalDigest(product, variants),
    },
    product,
    variants,
  );
  assert.ok(planned.ok, JSON.stringify(planned));
  const root = rows.catalogDetailApprovals?.[0];
  assert.ok(root);
  root.createdAt = new Date(Date.now() - 5000).toISOString();
  const command = {
    action: 'operation-approval-begin',
    productId: 'p',
    operationId: uuid,
    inputDigest: result.record.operation.inputDigest,
    prepared: planned.value,
  };
  return {
    product,
    rows,
    start,
    command,
    key: result.record._id,
    invoke: (input: unknown, actor = 'admin'): Promise<unknown> =>
      Reflect.apply(runStagedApproval, undefined, [tx, actor, input]),
    bytes: () => JSON.stringify(rows),
    writes: () => writes,
    fail: () => {
      fail = true;
    },
  };
}

test('own approval begins in the saved root and lost begin response recovers the original cursor without writes', async () => {
  const h = await fixture();
  const original = structuredClone(h.rows.catalogDetailApprovals?.[0]);
  assert.ok(original);
  const beforeProduct = structuredClone(h.product);
  const before = h.writes();
  const begun = object(await h.invoke(h.command));
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const record = object(begun.record);
  assert.equal(record.state, 'staging');
  assert.equal(record._id, h.key);
  assert.equal(record.createdAt, original.createdAt);
  assert.deepEqual(record.operation, original.operation);
  assert.deepEqual(record.saved, original.saved);
  assert.equal(record.revision, h.command.prepared.revision);
  assert.equal(begun.current, true);
  assert.equal(begun.revisionCurrent, true);
  assert.equal(begun.expired, false);
  assert.equal(h.writes() - before, 1);
  assert.deepEqual(h.product, beforeProduct);
  assert.equal(h.rows.catalogDetailApprovals?.length, 1);
  const snapshot = h.bytes();
  const count = h.writes();
  const got = object(await h.invoke(query));
  assert.deepEqual(got, begun);
  assert.deepEqual(await h.invoke(h.start), begun);
  const retry = structuredClone(h.command);
  retry.prepared.revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  retry.prepared.publication.revision = retry.prepared.revision;
  retry.prepared.createdAt = new Date(Date.now() + 123).toISOString();
  assert.deepEqual(await h.invoke(retry), begun);
  assert.equal(h.bytes(), snapshot);
  assert.equal(h.writes(), count);
  for (const action of ['page', 'finish']) {
    const answer = object(
      await h.invoke({ action, jobId: h.key, ...(action === 'page' ? { page: 0 } : {}) }),
    );
    assert.equal(answer.ok, false);
  }
  assert.equal(h.bytes(), snapshot);
  assert.equal(h.writes(), count);
  assert.equal(h.product.published, false);
  assert.equal(h.product.catalogDetailApprovalReceipt, undefined);
});
for (const mode of [
  'not-saved',
  'wrong-intent',
  'wrong-actor',
  'member',
  'digest',
  'key',
  'product',
  'prepared-actor',
  'request',
  'fingerprint',
  'expected-revision',
  'publication-revision',
  'variant-count',
  'next-page',
  'expired',
  'future',
  'content',
  'classification',
  'lifecycle',
  'identity',
  'approved',
  'updated-at',
  'policy',
] as const)
  test(`own approval rejects ${mode} before any write`, async () => {
    const h = await fixture(
      mode === 'wrong-intent' ? 'save-draft' : 'publish',
      mode !== 'not-saved',
    );
    let actor = 'admin';
    const cmd = structuredClone(h.command);
    const root = h.rows.catalogDetailApprovals?.[0];
    assert.ok(root);
    if (mode === 'wrong-actor') actor = 'other';
    if (mode === 'member') actor = 'guest';
    if (mode === 'digest') cmd.inputDigest = '0'.repeat(64);
    if (mode === 'key') cmd.prepared._id = '0'.repeat(64);
    if (mode === 'product') cmd.prepared.productId = 'other';
    if (mode === 'prepared-actor') cmd.prepared.actorId = 'other';
    if (mode === 'request') cmd.operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if (mode === 'fingerprint') cmd.prepared.productFingerprint = '0'.repeat(64);
    if (mode === 'expected-revision') cmd.prepared.expectedRevision = 'other';
    if (mode === 'publication-revision') cmd.prepared.publication.revision = 'other';
    if (mode === 'variant-count') cmd.prepared.publication.variantCount = 1;
    if (mode === 'next-page') cmd.prepared.nextPage = 1;
    if (mode === 'expired')
      root.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    if (mode === 'future') root.createdAt = new Date(Date.now() + 60000).toISOString();
    if (mode === 'content') h.product.description = 'Changed';
    if (mode === 'classification') h.product.catalogClassificationRevision = 1;
    if (mode === 'lifecycle') h.product.catalogLifecycleVersion = 2;
    if (mode === 'identity') h.product.alibabaLinkRevision = 9;
    if (mode === 'approved')
      h.product.catalogDetailPublication = { state: 'approved', revision: 'new' };
    if (mode === 'updated-at') h.product.updatedAt = new Date(Date.now() + 1000).toISOString();
    if (mode === 'policy') object(object(root.operation).policy).media = 'changed';
    const snapshot = h.bytes();
    const count = h.writes();
    const answer = object(await h.invoke(cmd, actor));
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.equal(h.bytes(), snapshot);
    assert.equal(h.writes(), count);
  });
test('own approval rejects changed prepared content on retry and reports subsequent edits as stale', async () => {
  const h = await fixture();
  assert.equal(object(await h.invoke(h.command)).ok, true);
  const bytes = h.bytes();
  const retry = structuredClone(h.command);
  retry.prepared.publication.header.name = 'Not reviewed';
  assert.equal(object(await h.invoke(retry)).ok, false);
  assert.equal(h.bytes(), bytes);
  h.product.catalogLifecycleVersion = 2;
  const got = object(await h.invoke(query));
  assert.equal(got.ok, true);
  assert.equal(got.current, false);
  assert.equal(object(await h.invoke(h.command)).ok, false);
});
test('own approval does not replace a pre-existing legacy root', async () => {
  const h = await fixture();
  h.rows.catalogDetailApprovals = [structuredClone(h.command.prepared)];
  const bytes = h.bytes();
  assert.equal(object(await h.invoke(h.command)).ok, false);
  assert.equal(h.bytes(), bytes);
});
test('a large legal UTF8 approval preserves all facts and component budgets in its combined root', async () => {
  const h = await fixture('publish', true, true);
  assert.ok(Buffer.byteLength(JSON.stringify(h.command.prepared)) > 256 * 1024);
  const answer = object(await h.invoke(h.command));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const root = object(answer.record);
  const facts = object(object(root.publication).header).facts;
  assert.deepEqual(facts, h.command.prepared.publication.header.facts);
  assert.ok(Buffer.byteLength(JSON.stringify(root)) > 512 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(root)) < 1024 * 1024);
  assert.equal(object(await h.invoke(query)).current, true);
});
test('unacknowledged own approval write throws without claiming a receipt', async () => {
  const h = await fixture();
  const bytes = h.bytes();
  h.fail();
  await assert.rejects(h.invoke(h.command), /unacknowledged owned approval/);
  assert.equal(h.bytes(), bytes);
});

test('owned staging query invalidates a changed prepared source projection without rewriting history', async () => {
  const h = await fixture();
  assert.equal(object(await h.invoke(h.command)).ok, true);
  h.product.detailSourceReady = false;
  const count = h.writes();
  const got = object(await h.invoke(query));
  assert.equal(got.ok, true);
  assert.equal(got.current, false);
  assert.equal(h.writes(), count);
});

test('owned envelope cannot enlarge the existing legacy approval component limit', async () => {
  const h = await fixture('publish', true, true);
  for (const fact of h.command.prepared.publication.header.facts) fact.value += '中'.repeat(66);
  assert.ok(Buffer.byteLength(JSON.stringify(h.command.prepared)) > 512 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(h.command.prepared)) < 1024 * 1024);
  const bytes = h.bytes();
  assert.equal(object(await h.invoke(h.command)).ok, false);
  assert.equal(h.bytes(), bytes);
});

for (const afterBegin of [false, true])
  for (const collection of [
    'alibabaSourceProducts',
    'catalogSourceObservations',
    'alibabaProductLinks',
  ] as const)
    test(`owned approval refuses changed source binding ${collection}: begun=${afterBegin}`, async () => {
      const h = await fixture('publish', true, false, true);
      if (afterBegin) assert.equal(object(await h.invoke(h.command)).ok, true);
      const row = h.rows[collection]?.[0];
      assert.ok(row);
      if (collection === 'alibabaSourceProducts') row.contentHash = 'b'.repeat(64);
      if (collection === 'catalogSourceObservations')
        row.observation = {
          source: {
            provider: 'alibaba',
            sourceProductKey: 's',
            externalProductId: 'ext',
            observedAt: new Date().toISOString(),
          },
          attributes: [{ name: 'Size', value: '20' }],
        };
      if (collection === 'alibabaProductLinks') row.productId = 'other';
      const bytes = h.bytes();
      const count = h.writes();
      assert.equal(object(await h.invoke(h.command)).ok, false);
      assert.equal(h.bytes(), bytes);
      assert.equal(h.writes(), count);
      const get = object(await h.invoke(query));
      assert.equal(get.ok, true);
      assert.equal(get.current, false);
    });

async function pageFixture(count = 21) {
  const h = await fixture('publish', true, false, true, count);
  const begun = object(await h.invoke(h.command));
  assert.equal(begun.ok, true, JSON.stringify(begun));
  return {
    ...h,
    page: (page: number) => ({
      action: 'operation-approval-page',
      productId: 'p',
      operationId: uuid,
      inputDigest: h.command.inputDigest,
      page,
    }),
  };
}
test('own approval pages persist21immutable variants with one original cursor and no publication', async () => {
  const h = await pageFixture();
  const original = object(object(await h.invoke(query)).record);
  const writes = h.writes();
  const first = object(await h.invoke(h.page(0)));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(object(first.record).nextPage, 1);
  assert.equal(h.writes() - writes, 21);
  assert.equal(h.rows.catalogDetailVariants?.length, 20);
  const recovered = object(await h.invoke(query));
  assert.equal(object(recovered.record).nextPage, 1);
  const bytes = h.bytes();
  const count = h.writes();
  assert.deepEqual(await h.invoke(h.page(0)), recovered);
  assert.equal(h.bytes(), bytes);
  assert.equal(h.writes(), count);
  const second = object(await h.invoke(h.page(1)));
  assert.equal(second.ok, true, JSON.stringify(second));
  const record = object(second.record);
  assert.equal(record.nextPage, 2);
  assert.equal(record.state, 'staging');
  assert.deepEqual(record.operation, original.operation);
  assert.deepEqual(record.saved, original.saved);
  assert.equal(record.createdAt, original.createdAt);
  assert.equal(h.rows.catalogDetailApprovals?.length, 1);
  assert.equal(h.rows.catalogDetailVariants?.length, 21);
  for (const [i, row] of (h.rows.catalogDetailVariants ?? []).entries()) {
    assert.equal(row.productId, 'p');
    assert.equal(row.catalogDetailRevision, record.revision);
    assert.equal(row.catalogDetailPosition, i);
    assert.equal(row.variantId, `v${i}`);
    assert.equal(object(row.catalogDetailApproved).id, `v${i}`);
    assert.notEqual(row._id, `v${i}`);
  }
  const final = h.bytes();
  const written = h.writes();
  assert.deepEqual(await h.invoke(h.start), second);
  assert.deepEqual(await h.invoke(h.page(0)), second);
  assert.deepEqual(await h.invoke(h.page(1)), second);
  assert.equal(h.bytes(), final);
  assert.equal(h.writes(), written);
  assert.equal(h.product.published, false);
  assert.equal(h.product.catalogDetailPublication, undefined);
  assert.equal(h.product.catalogDetailApprovalReceipt, undefined);
});
test('own approval handles105variants in six bounded pages', async () => {
  const h = await pageFixture(105);
  for (let page = 0; page < 6; page++) {
    const before = h.writes();
    const result = object(await h.invoke(h.page(page)));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(object(result.record).nextPage, page + 1);
    assert.ok(h.writes() - before <= 21);
  }
  assert.equal(h.rows.catalogDetailVariants?.length, 105);
  assert.equal(h.product.published, false);
});
for (const change of [
  'future-page',
  'bad-page',
  'wrong-digest',
  'other-actor',
  'member',
  'expired',
  'lifecycle',
  'classification',
  'source',
  'source-row-revision',
  'missing-source-row',
  'source-row-content',
] as const)
  test(`own page refuses ${change} without any row/cursor write`, async () => {
    const h = await pageFixture();
    const cmd = h.page(0);
    let actor = 'admin';
    const root = h.rows.catalogDetailApprovals?.[0];
    assert.ok(root);
    const variant = h.rows.productVariants?.[0];
    assert.ok(variant);
    if (change === 'future-page') cmd.page = 1;
    if (change === 'bad-page') cmd.page = 500;
    if (change === 'wrong-digest') cmd.inputDigest = '0'.repeat(64);
    if (change === 'other-actor') actor = 'other';
    if (change === 'member') actor = 'guest';
    if (change === 'expired')
      root.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    if (change === 'lifecycle') h.product.catalogLifecycleVersion = 2;
    if (change === 'classification') h.product.catalogClassificationRevision = 1;
    if (change === 'source') {
      const source = h.rows.alibabaSourceProducts?.[0];
      assert.ok(source);
      source.contentHash = 'b'.repeat(64);
    }
    if (change === 'source-row-revision') variant.detailSourceRevision = 'changed';
    if (change === 'missing-source-row') h.rows.productVariants = [];
    if (change === 'source-row-content') variant.optionValues = { Color: 'unreviewed' };
    const bytes = h.bytes();
    const writes = h.writes();
    assert.equal(object(await h.invoke(cmd, actor)).ok, false);
    assert.equal(h.bytes(), bytes);
    assert.equal(h.writes(), writes);
  });

for (const change of ['product', 'owner', 'missing', 'candidate-id', 'archived'] as const)
  test(`own page refuses foreign or inactive configuration ${change}`, async () => {
    const h = await pageFixture();
    const row = h.rows.productVariants?.[0];
    assert.ok(row);
    if (change === 'product') row.productId = 'other';
    if (change === 'owner') row.detailSourceOwner = 'foreign';
    if (change === 'missing') row.detailSourceMissing = true;
    if (change === 'candidate-id') object(row.detailSourceCandidate).id = 'other';
    if (change === 'archived') row.archived = true;
    const before = h.bytes();
    assert.equal(object(await h.invoke(h.page(0))).ok, false);
    assert.equal(h.bytes(), before);
  });
for (const change of ['role', 'expired', 'future', 'lifecycle', 'updated-at', 'source'] as const)
  test(`a saved page cannot replay across a changed ${change}`, async () => {
    const h = await pageFixture();
    assert.equal(object(await h.invoke(h.page(0))).ok, true);
    if (change === 'role') {
      const user = h.rows.users?.find((u) => u._id === 'admin');
      assert.ok(user);
      user.status = 'suspended';
    }
    if (change === 'expired' || change === 'future') {
      const root = h.rows.catalogDetailApprovals?.[0];
      assert.ok(root);
      root.createdAt = new Date(
        Date.now() + (change === 'future' ? 60000 : -7200000),
      ).toISOString();
    }
    if (change === 'lifecycle') h.product.catalogLifecycleVersion = 2;
    if (change === 'updated-at') h.product.updatedAt = new Date(Date.now() + 1000).toISOString();
    if (change === 'source') {
      const source = h.rows.alibabaSourceProducts?.[0];
      assert.ok(source);
      source.contentHash = 'c'.repeat(64);
    }
    const before = h.bytes();
    const writes = h.writes();
    assert.equal(object(await h.invoke(h.page(0))).ok, false);
    assert.equal(h.bytes(), before);
    assert.equal(h.writes(), writes);
  });
test('capture-only metadata allows the remaining own page without changing its source baseline', async () => {
  const h = await pageFixture();
  assert.equal(object(await h.invoke(h.page(0))).ok, true);
  const source = h.rows.alibabaSourceProducts?.[0];
  assert.ok(source);
  source.updatedAt = new Date().toISOString();
  source.lastSeenAt = new Date().toISOString();
  const variant = h.rows.productVariants?.[20];
  assert.ok(variant);
  variant.updatedAt = new Date().toISOString();
  const result = object(await h.invoke(h.page(1)));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(object(result.record).nextPage, 2);
});
test('codec budget retains512KiB of payload when the valid cursor grows to two digits', async () => {
  const h = await fixture('publish', true, false, false, 201);
  const job = structuredClone(h.command.prepared);
  job.publication.header.facts = Array.from({ length: 256 }, (_, i) => ({
    name: `F${i}`,
    value: 'x'.repeat(1900),
  }));
  for (const fact of job.publication.header.facts) {
    const remaining = CATALOG_APPROVAL_JOB_MAX_BYTES - Buffer.byteLength(JSON.stringify(job));
    if (!remaining) break;
    fact.name += 'n'.repeat(Math.min(remaining, 200 - fact.name.length));
  }
  assert.equal(Buffer.byteLength(JSON.stringify(job)), CATALOG_APPROVAL_JOB_MAX_BYTES);
  assert.ok(ApprovalJobSchema.safeParse(job).success);
  assert.equal(fitsApprovalJobBudget(job), true);
  job.nextPage = 10;
  assert.ok(ApprovalJobSchema.safeParse(job).success);
  assert.ok(Buffer.byteLength(JSON.stringify(job)) > CATALOG_APPROVAL_JOB_MAX_BYTES);
  assert.equal(fitsApprovalJobBudget(job), true);
  const available = job.publication.header.facts.find((f) => f.name.length < 200);
  assert.ok(available);
  available.name += 'n';
  assert.ok(ApprovalJobSchema.safeParse(job).success);
  assert.equal(fitsApprovalJobBudget(job), false);
  // This is a pure valid-schema codec boundary; no altered candidate is persisted or claimed server-prepared.
  assert.equal(h.rows.catalogDetailVariants?.length, 0);
});

test('owned pages preserve the entire previously approved draft and its original revision', async () => {
  const old = {
    state: 'approved',
    revision: 'older',
    variantCount: 0,
    header: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'p',
      name: 'Previously reviewed',
      images: [],
      facts: [],
      offers: [],
    },
  };
  const h = await fixture('publish', true, false, true, 21, { catalogDetailPublication: old });
  const before = structuredClone(h.product);
  assert.equal(object(await h.invoke(h.command)).ok, true);
  for (const page of [0, 1])
    assert.equal(
      object(
        await h.invoke({
          action: 'operation-approval-page',
          productId: 'p',
          operationId: uuid,
          inputDigest: h.command.inputDigest,
          page,
        }),
      ).ok,
      true,
    );
  assert.deepEqual(h.product, before);
  assert.deepEqual(h.product.catalogDetailPublication, old);
});
test('an empty owned approval and an unsaved approval have no page to commit', async () => {
  const h = await pageFixture(0);
  const before = h.bytes();
  assert.equal(object(await h.invoke(h.page(0))).ok, false);
  assert.equal(h.bytes(), before);
  const unbegun = await fixture('publish', true, false, true, 21);
  const bytes = unbegun.bytes();
  assert.equal(
    object(
      await unbegun.invoke({
        action: 'operation-approval-page',
        productId: 'p',
        operationId: uuid,
        inputDigest: unbegun.command.inputDigest,
        page: 0,
      }),
    ).ok,
    false,
  );
  assert.equal(unbegun.bytes(), bytes);
});
