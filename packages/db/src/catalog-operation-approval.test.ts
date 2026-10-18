import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { CATALOG_APPROVAL_JOB_MAX_BYTES } from '@vibelingan-channel/shared/catalog-detail-approval';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import { firstApprovalImageHold } from './catalog-approval-image-hold.ts';
import { ApprovalJobSchema, fitsApprovalJobBudget } from './catalog-approval-job.ts';
import { catalogApprovalDigest } from './catalog-detail-commit.ts';
import { prepareStagedApproval, runStagedApproval } from './catalog-detail-staging.ts';
import { runCatalogApprovalWorkflow } from './catalog-detail-workflow.ts';
import { buildCatalogImageReferencePlan } from './catalog-image-references.ts';
import { readOwnedApprovalMedia } from './catalog-operation-media.ts';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import { catalogSealedImageIdsDigest } from './catalog-preparation-media-seal.ts';
import {
  prepareProductOperationSave,
  productOperationSaveReceipt,
  runProductOperation,
} from './catalog-product-operation.ts';

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
    tx,
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

for (const phase of ['reserved', 'saved', 'staging'] as const)
  test(`cancel permanently stops its own ${phase} operation and preserves all prior work`, async () => {
    const h = await fixture('publish', phase !== 'reserved', false, false, 21, {
      imageIds: ['gallery'],
      descriptionImageIds: ['description'],
    });
    if (phase === 'staging') {
      assert.equal(object(await h.invoke(h.command)).ok, true);
      assert.equal(
        object(
          await h.invoke({
            ...query,
            action: 'operation-approval-page',
            inputDigest: h.command.inputDigest,
            page: 0,
          }),
        ).ok,
        true,
      );
    }
    const previous = structuredClone(h.rows.catalogDetailApprovals?.[0]);
    assert.ok(previous);
    const otherRows = JSON.stringify(
      Object.fromEntries(
        Object.entries(h.rows).filter(([key]) => key !== 'catalogDetailApprovals'),
      ),
    );
    const beforeWrites = h.writes();
    const cancelled = object(
      await h.invoke({ ...query, action: 'operation-cancel', inputDigest: h.command.inputDigest }),
    );
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.equal(cancelled.current, false);
    const current = object(cancelled.record);
    const metadata = object(current.operation);
    assert.equal(typeof metadata.cancelledAt, 'string');
    assert.ok(Number.isFinite(Date.parse(String(metadata.cancelledAt))));
    const { cancelledAt: _timestamp, ...input } = metadata;
    assert.deepEqual(input, previous.operation);
    assert.deepEqual({ ...current, operation: input }, previous);
    assert.equal(h.writes(), beforeWrites + 1);
    assert.equal(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(h.rows).filter(([key]) => key !== 'catalogDetailApprovals'),
        ),
      ),
      otherRows,
    );
    const bytes = h.bytes();
    for (const command of [
      query,
      h.start,
      { ...query, action: 'operation-cancel', inputDigest: h.command.inputDigest },
    ]) {
      const answer = object(await h.invoke(command));
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.equal(answer.current, false);
      assert.deepEqual(answer.record, current);
    }
    assert.deepEqual(await h.invoke(h.command), { ok: false, code: 'CONFLICT' });
    assert.deepEqual(
      await h.invoke({
        ...query,
        action: 'operation-approval-page',
        inputDigest: h.command.inputDigest,
        page: 0,
      }),
      { ok: false, code: 'CONFLICT' },
    );
    assert.equal(h.bytes(), bytes);
    assert.equal(h.writes(), beforeWrites + 1);
    if (phase === 'staging') {
      const cutoff = new Date(Date.now() - 70 * 60 * 1000).toISOString();
      for (const imageId of ['gallery', 'description']) {
        assert.equal(firstApprovalImageHold([previous], imageId, cutoff), 'p');
        assert.equal(
          firstApprovalImageHold(h.rows.catalogDetailApprovals ?? [], imageId, cutoff),
          null,
        );
      }
    }
  });

for (const change of ['source-changed', 'expired', 'missing-product', 'already-live'] as const)
  test(`cancel can stop a noncurrent operation without reapproving its data: ${change}`, async () => {
    const h = await fixture('publish', true, false, true);
    assert.equal(object(await h.invoke(h.command)).ok, true);
    const root = h.rows.catalogDetailApprovals?.[0];
    assert.ok(root);
    if (change === 'source-changed') {
      const source = h.rows.alibabaSourceProducts?.[0];
      assert.ok(source);
      source.contentHash = 'b'.repeat(64);
    } else if (change === 'expired')
      root.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    else if (change === 'already-live') h.product.published = true;
    else h.rows.products = [];
    const before = h.writes();
    const result = object(
      await h.invoke({ ...query, action: 'operation-cancel', inputDigest: h.command.inputDigest }),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.current, false);
    assert.equal(h.writes(), before + 1);
    if (change === 'already-live')
      assert.equal(h.rows.products?.find((row) => row._id === 'p')?.published, true);
  });

for (const change of ['wrong-digest', 'other-actor', 'revoked', 'client-time'] as const)
  test(`cancel refuses ${change} without changing its root`, async () => {
    const h = await fixture();
    assert.equal(object(await h.invoke(h.command)).ok, true);
    const command: Record<string, unknown> = {
      ...query,
      action: 'operation-cancel',
      inputDigest: h.command.inputDigest,
    };
    if (change === 'wrong-digest') command.inputDigest = '0'.repeat(64);
    if (change === 'client-time') command.cancelledAt = new Date().toISOString();
    if (change === 'revoked') {
      const actor = h.rows.users?.find((row) => row._id === 'admin');
      assert.ok(actor);
      actor.status = 'suspended';
    }
    const bytes = h.bytes();
    const writes = h.writes();
    const result = object(await h.invoke(command, change === 'other-actor' ? 'other' : 'admin'));
    assert.equal(result.ok, false);
    assert.equal(h.bytes(), bytes);
    assert.equal(h.writes(), writes);
  });

test('failed cancellation leaves the root active and queryable rather than reporting false success', async () => {
  const h = await fixture();
  assert.equal(object(await h.invoke(h.command)).ok, true);
  const bytes = h.bytes();
  h.fail();
  await assert.rejects(
    h.invoke({ ...query, action: 'operation-cancel', inputDigest: h.command.inputDigest }),
    /unacknowledged owned approval/,
  );
  assert.equal(h.bytes(), bytes);
  assert.equal(object(await h.invoke(query)).current, true);
});

for (const marker of [undefined, null, 'bad-time'])
  test(`a malformed persisted cancellation cannot be treated as active: ${String(marker)}`, async () => {
    const h = await fixture();
    assert.equal(object(await h.invoke(h.command)).ok, true);
    const root = h.rows.catalogDetailApprovals?.[0];
    assert.ok(root);
    object(root.operation).cancelledAt = marker;
    const bytes = h.bytes();
    assert.equal(object(await h.invoke(query)).ok, false);
    assert.deepEqual(await h.invoke(h.command), { ok: false, code: 'CONFLICT' });
    assert.equal(h.bytes(), bytes);
  });

test('the legacy HTTP workflow cannot forward an internal cancellation command', async () => {
  let persisted = 0;
  const result = await runCatalogApprovalWorkflow(
    {
      get: async () => ({ _id: 'admin', role: 'admin' }),
      persist: async () => {
        persisted++;
        throw new Error('Internal command reached HTTP persistence');
      },
    },
    'admin',
    { ...query, action: 'operation-cancel', inputDigest: 'a'.repeat(64) },
  );
  assert.equal(result.ok, false);
  assert.equal(persisted, 0);
});

test('an old save after cancellation refuses before loading a broken supplier source', async () => {
  const h = await fixture('publish', true, false, true);
  assert.equal(object(await h.invoke(h.command)).ok, true);
  assert.equal(
    object(
      await h.invoke({ ...query, action: 'operation-cancel', inputDigest: h.command.inputDigest }),
    ).ok,
    true,
  );
  const expectedUpdatedAt = h.start.expectedUpdatedAt;
  assert.ok(typeof expectedUpdatedAt === 'string');
  const sourceCollections = new Set([
    'alibabaSourceProducts',
    'catalogSourceObservations',
    'alibabaProductLinks',
  ]);
  const writes = h.writes();
  const result = await prepareProductOperationSave(
    {
      ...h.tx,
      get: async (collection, id) => {
        if (sourceCollections.has(collection))
          throw new Error('Cancelled save fetched supplier data');
        return h.tx.get(collection, id);
      },
    },
    h.product,
    {
      mode: 'update',
      productId: 'p',
      data: h.start.values,
      expectedUpdatedAt,
      expectedOperation: {
        actorId: 'admin',
        operationId: uuid,
        inputDigest: h.command.inputDigest,
      },
    },
  );
  assert.deepEqual(result, { result: 'stale' });
  assert.equal(h.writes(), writes);
});

async function finishEmptyMedia(h: Awaited<ReturnType<typeof fixture>>) {
  const now = Date.now();
  const authority = createCatalogPreparationAuthority({
    secret: 'owned-media-handoff-test',
    environmentId: 'owned-media-handoff-test',
    now: () => now,
  });
  const run = (input: unknown) => runCatalogPreparationJob(h.tx, authority, input, now);
  const started = await run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(started.ok && 'progress' in started);
  const jobId = started.progress.jobId;
  const dispatched = await run({ action: 'dispatch', actorId: 'admin', jobId });
  assert.ok(dispatched.ok && 'call' in dispatched);
  const claimed = await run({
    action: 'claim',
    call: dispatched.call,
    owner: 'owned-media-worker',
  });
  assert.ok(claimed.ok && 'lease' in claimed);
  const scope = { jobId, lease: claimed.lease };
  const planDigest = 'f'.repeat(64);
  assert.equal((await run({ ...scope, action: 'bind-media-plan', planDigest, total: 0 })).ok, true);
  assert.equal((await run({ ...scope, action: 'bind-media-seal', planDigest })).ok, true);
  const job = await h.tx.get('catalogPreparationJobs', jobId);
  assert.ok(
    job && typeof job.inputDigest === 'string' && typeof job.contentGeneration === 'number',
  );
  const done = await run({
    ...scope,
    action: 'finish-preparation',
    inputDigest: job.inputDigest,
    contentGeneration: job.contentGeneration,
    planDigest,
    imageIdsDigest: catalogSealedImageIdsDigest([]),
    imageCount: 0,
    previewReady: true,
    issues: [],
  });
  assert.ok(done.ok && 'report' in done && done.report.state === 'ready', JSON.stringify(done));
  return { jobId, report: done.report };
}

for (const readyBeforeBegin of [true, false])
  test(`own media accepts a server-completed empty receipt with readyBeforeBegin=${readyBeforeBegin}`, async () => {
    const h = await fixture('publish', true, false, true, 21);
    if (!readyBeforeBegin) assert.equal(object(await h.invoke(h.command)).ok, true);
    const ready = await finishEmptyMedia(h);
    if (readyBeforeBegin) assert.equal(object(await h.invoke(h.command)).ok, true);
    const previous = structuredClone(h.rows.catalogDetailApprovals?.[0]);
    assert.ok(previous);
    const others = JSON.stringify(
      Object.fromEntries(
        Object.entries(h.rows).filter(([key]) => key !== 'catalogDetailApprovals'),
      ),
    );
    const writes = h.writes();
    const command = {
      ...query,
      action: 'operation-approval-media',
      inputDigest: h.command.inputDigest,
    };
    const result = object(await h.invoke(command));
    assert.equal(result.ok, true, JSON.stringify(result));
    const record = object(result.record);
    const media = object(record.media);
    assert.equal(media.kind, 'catalog-owned-approval-media-v1');
    assert.equal(media.preparationInputDigest, ready.report.inputDigest);
    assert.deepEqual(media.ready, ready.report.seal);
    assert.match(String(media.bindingDigest), /^[a-f0-9]{64}$/);
    const { media: _binding, ...withoutMedia } = record;
    assert.deepEqual(withoutMedia, previous);
    assert.equal(record.state, 'staging');
    assert.equal(result.current, true);
    assert.equal(h.writes(), writes + 1);
    assert.equal(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(h.rows).filter(([key]) => key !== 'catalogDetailApprovals'),
        ),
      ),
      others,
    );
    const bytes = h.bytes();
    assert.deepEqual(await h.invoke(command), result);
    assert.deepEqual(await h.invoke(query), result);
    assert.deepEqual(await h.invoke(h.command), result);
    assert.equal(h.bytes(), bytes);
    assert.equal(h.writes(), writes + 1);
    assert.equal(h.rows.products?.[0]?.published, false);
  });

const mediaCommand = { ...query, action: 'operation-approval-media' as const };
const mediaFailures = [
  'not-ready',
  'missing-job',
  'other-job-product',
  'incomplete-job',
  'changed-nonce',
  'missing-completion',
  'changed-command',
  'changed-report',
  'changed-receipt',
  'incomplete-media',
  'invalid-media',
  'retry-media',
  'incomplete-seal',
  'changed-plan',
  'changed-seal-ids',
  'changed-image-count',
  'old-media-policy',
  'old-pixel-policy',
  'other-report-product',
  'old-preparation-policy',
  'changed-generation',
  'changed-source',
  'changed-link',
  'revoked-actor',
  'cancelled-operation',
  'expired-operation',
  'future-operation',
  'missing-product',
] as const;
for (const change of mediaFailures)
  test(`own media rejects ${change} without any writes`, async () => {
    const h = await fixture('publish', true, false, true);
    assert.equal(object(await h.invoke(h.command)).ok, true);
    const ready = await finishEmptyMedia(h);
    const product = h.rows.products?.[0];
    const job = h.rows.catalogPreparationJobs?.find((row) => row._id === ready.jobId);
    const root = h.rows.catalogDetailApprovals?.[0];
    assert.ok(product && job && root);
    const report = object(product.catalogPreparationReport);
    const seal = object(report.seal);
    if (change === 'not-ready') product.catalogPreparationState = 'unchecked';
    if (change === 'missing-job') h.rows.catalogPreparationJobs = [];
    if (change === 'other-job-product') job.productId = 'other';
    if (change === 'incomplete-job') job.state = 'running';
    if (change === 'changed-nonce') job.nonce = 'b'.repeat(64);
    if (change === 'missing-completion') Reflect.deleteProperty(job, 'completion');
    if (change === 'changed-command') object(job.completion).commandDigest = 'b'.repeat(64);
    if (change === 'changed-report') object(job.completion).reportDigest = 'b'.repeat(64);
    if (change === 'changed-receipt') seal.receiptId = 'b'.repeat(64);
    if (change === 'incomplete-media') object(job.media).total = 1;
    if (change === 'invalid-media') object(job.media).invalid = 1;
    if (change === 'retry-media') object(job.media).retry = 1;
    if (change === 'incomplete-seal') object(job.mediaSeal).total = 1;
    if (change === 'changed-plan') object(job.mediaSeal).planDigest = 'b'.repeat(64);
    if (change === 'changed-seal-ids') object(job.mediaSeal).imageIdsDigest = 'b'.repeat(64);
    if (change === 'changed-image-count') seal.imageCount = 1;
    if (change === 'old-media-policy') seal.mediaPolicyVersion = 'previous-media-policy';
    if (change === 'old-pixel-policy') seal.pixelPolicyVersion = 'previous-pixel-policy';
    if (change === 'other-report-product') report.productId = 'other';
    if (change === 'old-preparation-policy') report.policyVersion = 'previous-preparation-policy';
    if (change === 'changed-generation') product.catalogContentGeneration = 1;
    if (change === 'changed-source') {
      const source = h.rows.alibabaSourceProducts?.[0];
      assert.ok(source);
      source.contentHash = 'b'.repeat(64);
    }
    if (change === 'changed-link') {
      const link = h.rows.alibabaProductLinks?.[0];
      assert.ok(link);
      link.productId = 'other';
    }
    if (change === 'revoked-actor') {
      const actor = h.rows.users?.find((row) => row._id === 'admin');
      assert.ok(actor);
      actor.status = 'suspended';
    }
    if (change === 'cancelled-operation')
      assert.equal(
        object(
          await h.invoke({
            ...query,
            action: 'operation-cancel',
            inputDigest: h.command.inputDigest,
          }),
        ).ok,
        true,
      );
    if (change === 'expired-operation' || change === 'future-operation')
      root.createdAt = new Date(
        Date.now() + (change === 'future-operation' ? 60000 : -7200000),
      ).toISOString();
    if (change === 'missing-product') h.rows.products = [];
    const before = h.bytes();
    const writes = h.writes();
    const result = object(await h.invoke({ ...mediaCommand, inputDigest: h.command.inputDigest }));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(h.bytes(), before);
    assert.equal(h.writes(), writes);
  });

test('own media requires a completed server receipt, refusing a browser-shaped ready report', async () => {
  const h = await fixture();
  assert.equal(object(await h.invoke(h.command)).ok, true);
  await finishEmptyMedia(h);
  const before = h.bytes();
  assert.equal(
    object(
      await h.invoke({
        ...mediaCommand,
        inputDigest: h.command.inputDigest,
        report: h.rows.products?.[0]?.catalogPreparationReport,
      }),
    ).ok,
    false,
  );
  assert.equal(h.bytes(), before);
});

test('own media transfer stays bounded with21 configurations and survives both approval pages', async () => {
  const h = await fixture('publish', true, false, true, 21);
  await finishEmptyMedia(h);
  assert.equal(object(await h.invoke(h.command)).ok, true);
  let reads = 0;
  let writes = 0;
  const tx = {
    get: async (collection: string, id: string) => {
      reads++;
      return h.tx.get(collection, id);
    },
    set: async (collection: string, row: CollectionDoc) => {
      writes++;
      return h.tx.set(collection, row);
    },
  };
  const command = { ...mediaCommand, inputDigest: h.command.inputDigest };
  const result = await runStagedApproval(tx, 'admin', command);
  assert.ok(
    result.ok && 'record' in result && result.record.state === 'staging',
    JSON.stringify(result),
  );
  const bound = result.record;
  assert.equal(reads, 11);
  assert.equal(writes, 1);
  assert.equal(bound.nextPage, 0);
  assert.ok(bound.media);
  assert.equal(
    ApprovalJobSchema.safeParse(bound).success,
    false,
    'legacy cannot consume an owned root',
  );
  for (const page of [0, 1]) {
    const staged = object(await h.invoke({ ...command, action: 'operation-approval-page', page }));
    assert.equal(staged.ok, true, JSON.stringify(staged));
    assert.equal(object(staged.record).nextPage, page + 1);
    assert.deepEqual(object(staged.record).media, bound.media);
  }
  assert.equal(h.rows.catalogDetailVariants?.length, 21);
  const before = h.bytes();
  const replay = object(await h.invoke(command));
  assert.equal(replay.ok, true);
  assert.equal(object(replay.record).nextPage, 2);
  assert.deepEqual(object(replay.record).media, bound.media);
  assert.equal(h.bytes(), before);
  const cancelled = object(await h.invoke({ ...command, action: 'operation-cancel' }));
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.current, false);
  assert.deepEqual(object(cancelled.record).media, bound.media);
  const afterCancel = h.bytes();
  assert.equal(object(await h.invoke(command)).ok, false);
  assert.equal(h.bytes(), afterCancel);
  assert.equal(h.rows.products?.[0]?.published, false);
});

for (const damage of [
  'undefined',
  'hash',
  'owner',
  'images',
  'input',
  'policy',
  'receipt',
  'bytes',
] as const)
  test(`own media codec refuses altered ${damage} on get and repeated begin`, async () => {
    const h = await fixture();
    await finishEmptyMedia(h);
    assert.equal(object(await h.invoke(h.command)).ok, true);
    assert.equal(
      object(await h.invoke({ ...mediaCommand, inputDigest: h.command.inputDigest })).ok,
      true,
    );
    const root = h.rows.catalogDetailApprovals?.[0];
    assert.ok(root);
    const media = object(root.media);
    if (damage === 'undefined') root.media = undefined;
    if (damage === 'hash') media.bindingDigest = 'b'.repeat(64);
    if (damage === 'owner') root.revision = 'another-revision';
    if (damage === 'images') object(object(root.publication).header).images = ['extra-image'];
    if (damage === 'input') media.preparationInputDigest = 'b'.repeat(64);
    if (damage === 'policy') object(media.ready).mediaPolicyVersion = 'previous-media-policy';
    if (damage === 'receipt') object(media.ready).receiptId = 'b'.repeat(64);
    if (damage === 'bytes') media.extra = 'x'.repeat(2049);
    const before = h.bytes();
    const writes = h.writes();
    assert.equal(object(await h.invoke(query)).ok, false);
    assert.equal(object(await h.invoke(h.command)).ok, false);
    assert.equal(h.bytes(), before);
    assert.equal(h.writes(), writes);
  });

test('media transfer rechecks operation expiry after asynchronous preparation reads', async () => {
  const h = await fixture();
  await finishEmptyMedia(h);
  assert.equal(object(await h.invoke(h.command)).ok, true);
  const before = h.bytes();
  const originalNow = Date.now;
  const now = Date.now();
  try {
    const tx = {
      ...h.tx,
      get: async (collection: string, id: string) => {
        const row = await h.tx.get(collection, id);
        if (collection === 'catalogPreparationJobs') Date.now = () => now + 7200000;
        return row;
      },
    };
    assert.deepEqual(
      await runStagedApproval(tx, 'admin', { ...mediaCommand, inputDigest: h.command.inputDigest }),
      { ok: false, code: 'APPROVAL_EXPIRED' },
    );
    assert.equal(h.bytes(), before);
  } finally {
    Date.now = originalNow;
  }
});

test('owned media history remains readable under a later policy while eligibility stays stale', async () => {
  const h = await fixture();
  await finishEmptyMedia(h);
  assert.equal(object(await h.invoke(h.command)).ok, true);
  const result = await runStagedApproval(h.tx, 'admin', {
    ...mediaCommand,
    inputDigest: h.command.inputDigest,
  });
  assert.ok(
    result.ok && 'record' in result && result.record.state === 'staging' && result.record.media,
  );
  const root = result.record;
  assert.ok(root.media);
  root.operation.policy.media = 'previous-media-policy';
  root.operation.policy.pixels = 'previous-pixel-policy';
  root.media.ready.mediaPolicyVersion = root.operation.policy.media;
  root.media.ready.pixelPolicyVersion = root.operation.policy.pixels;
  const { bindingDigest: _digest, ...body } = root.media;
  root.media.bindingDigest = alibabaPricingFingerprint([
    'catalog-owned-approval-media-v1',
    root._id,
    root.productId,
    root.operation.inputDigest,
    root.operation.policy,
    root.revision,
    root.productFingerprint,
    body,
  ]);
  assert.ok(readOwnedApprovalMedia(root, root.media));
  await h.tx.set('catalogDetailApprovals', root);
  const before = h.bytes();
  const read = object(await h.invoke(query));
  assert.equal(read.ok, true);
  assert.equal(read.current, false);
  assert.deepEqual(object(read.record).media, root.media);
  assert.equal(
    object(await h.invoke({ ...mediaCommand, inputDigest: h.command.inputDigest })).ok,
    false,
  );
  assert.equal(h.bytes(), before);
});

for (const mismatch of ['count', 'ids', 'media-policy', 'pixel-policy'] as const)
  test(`owned media refuses a self-consistent binding with different adopted ${mismatch}`, async () => {
    const h = await fixture();
    await finishEmptyMedia(h);
    assert.equal(object(await h.invoke(h.command)).ok, true);
    const result = await runStagedApproval(h.tx, 'admin', {
      ...mediaCommand,
      inputDigest: h.command.inputDigest,
    });
    assert.ok(result.ok && 'record' in result && result.record.state === 'staging');
    const root = result.record;
    assert.ok(root.media);
    if (mismatch === 'count') root.media.ready.imageCount = 1;
    if (mismatch === 'ids') root.media.ready.imageIdsDigest = 'b'.repeat(64);
    if (mismatch === 'media-policy') root.media.ready.mediaPolicyVersion = 'other-policy';
    if (mismatch === 'pixel-policy') root.media.ready.pixelPolicyVersion = 'other-policy';
    const { bindingDigest: _digest, ...body } = root.media;
    root.media.bindingDigest = alibabaPricingFingerprint([
      'catalog-owned-approval-media-v1',
      root._id,
      root.productId,
      root.operation.inputDigest,
      root.operation.policy,
      root.revision,
      root.productFingerprint,
      body,
    ]);
    assert.equal(readOwnedApprovalMedia(root, root.media), null);
  });

const referencesCommand = { ...query, action: 'operation-approval-references' as const };
async function ownReferenceFixture(variants = 0, linked = false) {
  const h = await fixture('publish', true, false, linked, variants);
  assert.equal(object(await h.invoke(h.command)).ok, true);
  await finishEmptyMedia(h);
  assert.equal(
    object(await h.invoke({ ...mediaCommand, inputDigest: h.command.inputDigest })).ok,
    true,
  );
  return h;
}
for (const count of [0, 21])
  test(`own reference plan freezes in its existing root without publication, variants=${count}`, async () => {
    const h = await ownReferenceFixture(count, true);
    for (let page = 0; page < Math.ceil(count / 20); page++)
      assert.equal(
        object(
          await h.invoke({
            ...query,
            action: 'operation-approval-page',
            inputDigest: h.command.inputDigest,
            page,
          }),
        ).ok,
        true,
      );
    const original = structuredClone(h.rows.catalogDetailApprovals?.[0]);
    assert.ok(original);
    const otherRows = JSON.stringify(
      Object.fromEntries(
        Object.entries(h.rows).filter(([key]) => key !== 'catalogDetailApprovals'),
      ),
    );
    const writes = h.writes();
    const command = { ...referencesCommand, inputDigest: h.command.inputDigest };
    const result = object(await h.invoke(command));
    assert.equal(result.ok, true, JSON.stringify(result));
    const record = object(result.record);
    const binding = object(record.references);
    const plan = buildCatalogImageReferencePlan(h.key, [], []);
    assert.equal(binding.kind, 'catalog-owned-approval-references-v1');
    assert.equal(binding.operationRootId, h.key);
    assert.equal(binding.treeRoot, plan.proof.treeRoot);
    assert.equal(binding.leafCount, 0);
    assert.match(String(binding.bindingDigest), /^[a-f0-9]{64}$/);
    const { references: _binding, ...unchanged } = record;
    assert.deepEqual(unchanged, original);
    assert.equal(record.state, 'staging');
    assert.equal(result.current, true);
    assert.equal(h.writes(), writes + 1);
    assert.equal(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(h.rows).filter(([key]) => key !== 'catalogDetailApprovals'),
        ),
      ),
      otherRows,
    );
    const bytes = h.bytes();
    assert.deepEqual(await h.invoke(command), result);
    assert.deepEqual(await h.invoke(query), result);
    assert.deepEqual(await h.invoke(h.command), result);
    assert.deepEqual(
      await h.invoke({ ...mediaCommand, inputDigest: h.command.inputDigest }),
      result,
    );
    if (count)
      assert.deepEqual(
        await h.invoke({
          ...query,
          action: 'operation-approval-page',
          inputDigest: h.command.inputDigest,
          page: 0,
        }),
        result,
      );
    assert.equal(h.bytes(), bytes);
    assert.equal(h.writes(), writes + 1);
    assert.equal(h.rows.products?.[0]?.published, false);
    assert.equal(h.rows.catalogDetailApprovals?.length, 1);
  });
for (const [state, code] of [
  ['no-media', 'MEDIA_NOT_READY'],
  ['unpaged', 'SOURCE_NOT_READY'],
  ['cancelled', 'CONFLICT'],
  ['revoked', 'FORBIDDEN'],
  ['other-actor', 'CONFLICT'],
  ['expired', 'CONFLICT'],
  ['changed-product', 'CONFLICT'],
  ['changed-source', 'CONFLICT'],
  ['wrong-digest', 'CONFLICT'],
] as const)
  test(`own reference plan refuses ${state} before writes`, async () => {
    const h = await ownReferenceFixture(state === 'unpaged' ? 21 : 0, true);
    const root = h.rows.catalogDetailApprovals?.[0];
    assert.ok(root);
    if (state === 'no-media') Reflect.deleteProperty(root, 'media');
    if (state === 'cancelled')
      assert.equal(
        object(
          await h.invoke({
            ...query,
            action: 'operation-cancel',
            inputDigest: h.command.inputDigest,
          }),
        ).ok,
        true,
      );
    if (state === 'revoked') {
      const actor = h.rows.users?.find((row) => row._id === 'admin');
      assert.ok(actor);
      actor.status = 'suspended';
    }
    if (state === 'expired') root.createdAt = new Date(Date.now() - 3600001).toISOString();
    if (state === 'changed-product') {
      const product = h.rows.products?.[0];
      assert.ok(product);
      product.name = 'Changed website clock';
    }
    if (state === 'changed-source') {
      const source = h.rows.alibabaSourceProducts?.[0];
      assert.ok(source);
      source.contentHash = 'f'.repeat(64);
    }
    const before = h.bytes();
    const writes = h.writes();
    assert.deepEqual(
      await h.invoke(
        {
          ...referencesCommand,
          inputDigest: state === 'wrong-digest' ? '0'.repeat(64) : h.command.inputDigest,
        },
        state === 'other-actor' ? 'other' : 'admin',
      ),
      { ok: false, code },
    );
    assert.equal(h.bytes(), before);
    assert.equal(h.writes(), writes);
  });
test('own reference binding failure propagates without a published product or success receipt', async () => {
  const h = await ownReferenceFixture();
  const before = h.bytes();
  h.fail();
  await assert.rejects(
    h.invoke({ ...referencesCommand, inputDigest: h.command.inputDigest }),
    /unacknowledged owned approval/,
  );
  assert.equal(h.bytes(), before);
});
for (const field of ['references', 'treeRoot', 'leafCount', 'proof', 'now'])
  test(`client cannot submit reference evidence through ${field}`, async () => {
    const h = await ownReferenceFixture();
    const before = h.bytes();
    const result = object(
      await h.invoke({
        ...referencesCommand,
        inputDigest: h.command.inputDigest,
        [field]: 'client-evidence',
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(object(result.validation).issues));
    assert.equal(h.bytes(), before);
  });
test('the legacy HTTP workflow cannot forward internal reference freezing', async () => {
  let persisted = 0;
  const result = await runCatalogApprovalWorkflow(
    {
      get: async () => ({ _id: 'admin', role: 'admin' }),
      persist: async () => {
        persisted++;
        throw Error('internal reference command reached HTTP');
      },
    },
    'admin',
    { ...referencesCommand, inputDigest: 'a'.repeat(64) },
  );
  assert.equal(result.ok, false);
  assert.equal(persisted, 0);
});

for (const corrupt of ['undefined', 'null', 'wrong-tree', 'unfinished-page'] as const)
  test(`owned reference codec refuses persisted ${corrupt} rather than treating it as absent`, async () => {
    const h = await ownReferenceFixture(corrupt === 'unfinished-page' ? 21 : 0);
    if (corrupt === 'unfinished-page')
      for (const page of [0, 1])
        assert.equal(
          object(
            await h.invoke({
              ...query,
              action: 'operation-approval-page',
              inputDigest: h.command.inputDigest,
              page,
            }),
          ).ok,
          true,
        );
    assert.equal(
      object(await h.invoke({ ...referencesCommand, inputDigest: h.command.inputDigest })).ok,
      true,
    );
    const root = h.rows.catalogDetailApprovals?.[0];
    assert.ok(root);
    if (corrupt === 'undefined') root.references = undefined;
    if (corrupt === 'null') root.references = null;
    if (corrupt === 'wrong-tree') object(root.references).treeRoot = 'f'.repeat(64);
    if (corrupt === 'unfinished-page') root.nextPage = 0;
    const before = h.bytes();
    assert.deepEqual(await h.invoke(query), { ok: false, code: 'CONFLICT' });
    assert.equal(h.bytes(), before);
  });
test('cancellation preserves a frozen reference binding and cannot create a terminal proof', async () => {
  const h = await ownReferenceFixture();
  assert.equal(
    object(await h.invoke({ ...referencesCommand, inputDigest: h.command.inputDigest })).ok,
    true,
  );
  const root = h.rows.catalogDetailApprovals?.[0];
  assert.ok(root);
  const binding = structuredClone(root.references);
  const media = structuredClone(root.media);
  const result = object(
    await h.invoke({ ...query, action: 'operation-cancel', inputDigest: h.command.inputDigest }),
  );
  assert.equal(result.ok, true);
  const cancelled = object(result.record);
  assert.deepEqual(cancelled.references, binding);
  assert.deepEqual(cancelled.media, media);
  assert.equal(h.rows.catalogDetailApprovals?.length, 1);
  assert.equal(h.rows.products?.[0]?.published, false);
  const before = h.bytes();
  assert.deepEqual(await h.invoke({ ...referencesCommand, inputDigest: h.command.inputDigest }), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(h.bytes(), before);
});

test('reference freezing checks the service deadline again before its final root write', async () => {
  const h = await ownReferenceFixture();
  const root = h.rows.catalogDetailApprovals?.[0];
  assert.ok(root);
  const before = h.bytes();
  const writes = h.writes();
  const realNow = Date.now;
  const inTime = realNow();
  let checks = 0;
  try {
    // The initial current-state inspection is in time; the final commit check crosses the deadline.
    Date.now = () => (++checks === 1 ? inTime : inTime + 3600001);
    assert.deepEqual(await h.invoke({ ...referencesCommand, inputDigest: h.command.inputDigest }), {
      ok: false,
      code: 'APPROVAL_EXPIRED',
    });
    assert.equal(checks, 2);
    assert.equal(h.bytes(), before);
    assert.equal(h.writes(), writes);
  } finally {
    Date.now = realNow;
  }
});
