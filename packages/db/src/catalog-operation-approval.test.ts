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
import type { ApprovalPersistenceCommand, ApprovalStageResult } from './catalog-detail-staging.ts';
import { runCatalogApprovalWorkflow } from './catalog-detail-workflow.ts';
import { runCatalogImageReferenceRead } from './catalog-image-reference-store.ts';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceCancelProof,
  catalogImageReferenceEntry,
} from './catalog-image-references.ts';
import { readOwnedApprovalMedia } from './catalog-operation-media.ts';
import {
  REFERENCE_RECOVERY_BUDGET_MS,
  persistOwnedReferencePageWithRecovery,
} from './catalog-operation-reference-recovery.ts';
import {
  ownedReferenceStageProgress,
  planOwnedReferenceStagePage,
} from './catalog-operation-reference-stage.ts';
import { finishOwnedMediaFixture } from './catalog-owned-media.fixture.ts';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import { catalogSealedImageIdsDigest } from './catalog-preparation-media-seal.ts';
import { runProductOperationWorkflow } from './catalog-product-operation-workflow.ts';
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
  submittedInputDigest?: string,
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
    ...(submittedInputDigest === undefined ? {} : { submittedInputDigest }),
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

async function ownReferencePageFixture(
  imageCount = 1,
  extra: Record<string, unknown> = {},
  submittedInputDigest?: string,
) {
  const ids = Array.from({ length: imageCount }, (_, i) => `image${String(i).padStart(2, '0')}`);
  const h = await fixture(
    'publish',
    true,
    false,
    false,
    21,
    {
      imageIds: ids.slice(0, 9),
      descriptionImageIds: ids.slice(9),
      ...extra,
    },
    submittedInputDigest,
  );
  h.rows.images = ids.map((_id) => ({
    _id,
    status: 'active',
    storageProvider: 'local-disk',
    storageMode: 'local-disk',
    storageFileId: `local-disk:${_id}.png`,
    storagePath: `${_id}.png`,
    mimeType: 'image/png',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    publishedRefCount: 0,
  }));
  assert.equal(object(await h.invoke(h.command)).ok, true);
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
  const now = Date.now();
  const authority = createCatalogPreparationAuthority({
    secret: 'own-reference-page-unit',
    environmentId: 'own-reference-page-unit',
    now: () => now,
  });
  const run = (command: unknown) => runCatalogPreparationJob(h.tx, authority, command, now);
  await finishOwnedMediaFixture(run, h.tx.get, ids);
  assert.equal(
    object(await h.invoke({ ...mediaCommand, inputDigest: h.command.inputDigest })).ok,
    true,
  );
  const bound = object(
    await h.invoke({ ...referencesCommand, inputDigest: h.command.inputDigest }),
  );
  assert.equal(bound.ok, true, JSON.stringify(bound));
  return {
    ...h,
    ids,
    pageCommand: {
      ...query,
      action: 'operation-approval-reference-page' as const,
      inputDigest: h.command.inputDigest,
      cursor: 0,
    },
  };
}
test('reference-page fixture completes real server preparation and freezing for27 metadata images', async () => {
  const h = await ownReferencePageFixture(27);
  const current = object(await h.invoke(query));
  assert.equal(current.ok, true);
  const record = object(current.record);
  assert.equal(object(record.references).leafCount, 27);
  assert.equal(record.nextPage, 2);
  assert.equal(h.rows.images?.length, 27);
  assert.equal(h.rows.products?.[0]?.published, false);
  assert.equal(h.rows.catalogDetailApprovals?.length, 1);
});

for (const count of [1, 27])
  test(`own reference pages keep ${count} images private and acknowledge durable20-item prefixes`, async () => {
    const h = await ownReferencePageFixture(count);
    const rowsBefore = structuredClone(h.rows.images);
    const writes = h.writes();
    const first = object(await h.invoke(h.pageCommand));
    assert.equal(first.ok, true, JSON.stringify(first));
    const firstRoot = object(first.record);
    assert.equal(object(firstRoot.referenceStage).cursor, Math.min(count, 20));
    assert.equal(h.writes() - writes, Math.min(count, 20) + 1);
    for (const image of h.rows.images ?? []) assert.equal(image.publishedRefCount, 0);
    assert.equal(h.rows.products?.[0]?.published, false);
    assert.equal(h.rows.catalogDetailApprovals?.length, 1);
    const plan = buildCatalogImageReferencePlan(h.key, [], h.ids);
    for (let index = 0; index < Math.min(count, 20); index++) {
      const image = h.rows.images?.find((row) => row._id === h.ids[index]);
      assert.ok(image);
      const ledger = object(image.catalogPublishedReferenceLedger);
      assert.deepEqual(ledger.pending, [catalogImageReferenceEntry(plan, index)]);
      const read = await runCatalogImageReferenceRead(h.tx, { action: 'read', imageId: image._id });
      assert.ok(read.state === 'counted');
      assert.equal(read.effectiveCount, 0);
    }
    if (count > 20) {
      const next = object(await h.invoke({ ...h.pageCommand, cursor: 20 }));
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.equal(object(object(next.record).referenceStage).cursor, count);
    }
    const before = h.bytes();
    const beforeWrites = h.writes();
    const done = object(await h.invoke(query));
    assert.equal(object(object(done.record).referenceStage).cursor, count);
    assert.deepEqual(await h.invoke(h.pageCommand), done);
    assert.deepEqual(await h.invoke({ ...h.pageCommand, cursor: count }), done);
    assert.deepEqual(await h.invoke(h.command), done);
    assert.equal(h.bytes(), before);
    assert.equal(h.writes(), beforeWrites);
    assert.equal(h.rows.catalogDetailVariants?.length, 21);
    for (const image of h.rows.images ?? []) {
      const old = rowsBefore?.find((row) => row._id === image._id);
      assert.ok(old);
      for (const key of [
        'storageFileId',
        'storagePath',
        'mimeType',
        'checksumSha256',
        'byteSize',
        'catalogStorageProtection',
      ])
        assert.deepEqual(image[key], old[key]);
    }
  });
test('a reference page rejects an ahead cursor without any image or root writes', async () => {
  const h = await ownReferencePageFixture();
  const before = h.bytes();
  assert.deepEqual(await h.invoke({ ...h.pageCommand, cursor: 1 }), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(h.bytes(), before);
});
for (const fault of [
  'fresh-lock',
  'stale-lock',
  'missing-base',
  'null-base',
  'undefined-ledger',
  'missing-pixels',
  'wrong-image-id',
] as const)
  test(`own reference page refuses ${fault} with its whole prefix unchanged`, async () => {
    const h = await ownReferencePageFixture(2);
    const image = h.rows.images?.[1];
    assert.ok(image);
    if (fault === 'fresh-lock' || fault === 'stale-lock') {
      image.imageMutationOwner = 'other';
      image.imageMutationStartedAt = new Date(
        Date.now() - (fault === 'stale-lock' ? 3600000 : 0),
      ).toISOString();
    }
    if (fault === 'missing-base') Reflect.deleteProperty(image, 'publishedRefCount');
    if (fault === 'null-base') image.publishedRefCount = null;
    if (fault === 'undefined-ledger') image.catalogPublishedReferenceLedger = undefined;
    if (fault === 'missing-pixels')
      h.rows.catalogImageObservations =
        h.rows.catalogImageObservations?.filter(
          (row) => !(row.kind === 'catalog-protected-image-health-v1' && row.imageId === image._id),
        ) ?? [];
    if (fault === 'wrong-image-id') {
      const get = h.tx.get;
      h.tx.get = async (collection, id) => {
        const row = await get(collection, id);
        return collection === 'images' && id === image._id && row ? { ...row, _id: 'other' } : row;
      };
    }
    const before = h.bytes();
    const writes = h.writes();
    assert.deepEqual(await h.invoke(h.pageCommand), {
      ok: false,
      code: fault === 'fresh-lock' ? 'MEDIA_BUSY' : 'MEDIA_NOT_READY',
    });
    assert.equal(h.bytes(), before);
    assert.equal(h.writes(), writes);
  });
test('own reference page propagates real vendor failure without reporting media corruption', async () => {
  const h = await ownReferencePageFixture();
  const get = h.tx.get;
  h.tx.get = async (collection, id) => {
    if (collection === 'images') throw Error('reference page vendor unavailable');
    return get(collection, id);
  };
  const before = h.bytes();
  await assert.rejects(h.invoke(h.pageCommand), /reference page vendor unavailable/);
  assert.equal(h.bytes(), before);
});
for (const completed of [false, true])
  test(`full80 slot page is retryable and cancellation frees its next stage, completed=${completed}`, async () => {
    const h = await ownReferencePageFixture(27);
    const image = h.rows.images?.[0];
    assert.ok(image);
    const plans = Array.from({ length: 80 }, (_, i) =>
      buildCatalogImageReferencePlan((i + 500).toString(16).padStart(64, '0'), [], [image._id]),
    );
    image.catalogPublishedReferenceLedger = {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: plans.map((plan) => catalogImageReferenceEntry(plan, 0)),
    };
    const before = h.bytes();
    assert.deepEqual(await h.invoke(h.pageCommand), {
      ok: false,
      code: 'MEDIA_BUSY',
      pendingReferenceImageId: image._id,
    });
    assert.equal(h.bytes(), before);
    const released = completed ? plans : plans.slice(0, 1);
    h.rows.catalogDetailApprovals?.push(
      ...released.map((plan) => catalogImageReferenceCancelProof(plan.proof)),
    );
    const calls: string[] = [];
    const get = h.tx.get;
    const set = h.tx.set;
    h.tx.get = async (c, id) => {
      calls.push(`get:${c}/${id}`);
      return get(c, id);
    };
    h.tx.set = async (c, row) => {
      calls.push(`set:${c}/${row._id}`);
      await set(c, row);
    };
    const result = object(await h.invoke(h.pageCommand));
    assert.equal(result.ok, true, JSON.stringify(result));
    const cursor = object(object(result.record).referenceStage).cursor;
    assert.ok(typeof cursor === 'number' && cursor > 0 && cursor <= 20);
    assert.ok(calls.length <= 98, JSON.stringify(calls));
    let writing = false;
    for (const call of calls) {
      if (call.startsWith('set:')) writing = true;
      else assert.equal(writing, false, 'all page reads must precede image/root writes');
    }
    const current = h.rows.images?.[0];
    assert.ok(current);
    assert.equal(current.publishedRefCount, 0);
    const pending = object(current.catalogPublishedReferenceLedger).pending;
    assert.ok(Array.isArray(pending));
    assert.equal(pending.length, completed ? 1 : 80);
    assert.equal(h.rows.products?.[0]?.published, false);
  });
test('replaying an acknowledged prefix skips image reads even while a photo is temporarily busy', async () => {
  const h = await ownReferencePageFixture();
  assert.equal(object(await h.invoke(h.pageCommand)).ok, true);
  const image = h.rows.images?.[0];
  assert.ok(image);
  image.imageMutationOwner = 'other';
  image.imageMutationStartedAt = new Date().toISOString();
  const get = h.tx.get;
  h.tx.get = async (c, id) => {
    if (c === 'images') throw Error('acknowledged prefix reread image');
    return get(c, id);
  };
  const before = h.bytes();
  assert.equal(object(await h.invoke(h.pageCommand)).ok, true);
  assert.equal(h.bytes(), before);
});
test('cancelling staged references atomically records a permanent cancel proof and preserves unknown peers', async () => {
  const h = await ownReferencePageFixture();
  const image = h.rows.images?.[0];
  assert.ok(image);
  const peer = buildCatalogImageReferencePlan('f'.repeat(64), [], [image._id]);
  image.catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: [catalogImageReferenceEntry(peer, 0)],
  };
  assert.equal(object(await h.invoke(h.pageCommand)).ok, true);
  const plan = buildCatalogImageReferencePlan(h.key, [], h.ids);
  const result = object(
    await h.invoke({ ...query, action: 'operation-cancel', inputDigest: h.command.inputDigest }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.current, false);
  assert.deepEqual(
    await h.tx.get('catalogDetailApprovals', plan.proof._id),
    catalogImageReferenceCancelProof(plan.proof),
  );
  const saved = object(result.record);
  assert.equal(object(saved.referenceStage).cursor, 1);
  assert.ok(saved.media && saved.references);
  const before = h.bytes();
  assert.deepEqual(
    await h.invoke({ ...query, action: 'operation-cancel', inputDigest: h.command.inputDigest }),
    result,
  );
  assert.equal(h.bytes(), before);
  const settled = await runCatalogImageReferenceRead(h.tx, {
    action: 'settle',
    imageId: image._id,
  });
  assert.ok(settled.state === 'counted');
  assert.equal(settled.effectiveCount, 0);
  assert.deepEqual(object(settled.image.catalogPublishedReferenceLedger).pending, [
    catalogImageReferenceEntry(peer, 0),
  ]);
  assert.equal(h.rows.products?.[0]?.published, false);
});
for (const kind of ['commit', 'wrong-cancel'] as const)
  test(`cancel cannot overwrite the immutable ${kind} terminal slot`, async () => {
    const h = await ownReferencePageFixture();
    assert.equal(object(await h.invoke(h.pageCommand)).ok, true);
    const plan = buildCatalogImageReferencePlan(h.key, [], h.ids);
    const proof =
      kind === 'commit'
        ? plan.proof
        : { ...catalogImageReferenceCancelProof(plan.proof), treeRoot: 'f'.repeat(64) };
    h.rows.catalogDetailApprovals?.push(proof);
    const before = h.bytes();
    assert.deepEqual(
      await h.invoke({ ...query, action: 'operation-cancel', inputDigest: h.command.inputDigest }),
      { ok: false, code: 'CONFLICT' },
    );
    assert.equal(h.bytes(), before);
  });
test('an expired staged operation can cancel without reading newly broken supplier data', async () => {
  const h = await ownReferencePageFixture();
  assert.equal(object(await h.invoke(h.pageCommand)).ok, true);
  const root = h.rows.catalogDetailApprovals?.[0];
  const product = h.rows.products?.[0];
  assert.ok(root && product);
  root.createdAt = new Date(Date.now() - 3600001).toISOString();
  product.alibabaPrimarySourceKey = 'broken-source';
  const get = h.tx.get;
  h.tx.get = async (c, id) => {
    if (['alibabaSourceProducts', 'catalogSourceObservations', 'alibabaProductLinks'].includes(c))
      throw Error('cancel fetched broken source');
    return get(c, id);
  };
  const result = object(
    await h.invoke({ ...query, action: 'operation-cancel', inputDigest: h.command.inputDigest }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.current, false);
  assert.equal(result.expired, true);
});

for (const corrupt of [
  'undefined',
  'null',
  'binding',
  'cursor',
  'prefix',
  'no-references',
] as const)
  test(`reference-page codec refuses persisted ${corrupt} progress`, async () => {
    const h = await ownReferencePageFixture();
    assert.equal(object(await h.invoke(h.pageCommand)).ok, true);
    const root = h.rows.catalogDetailApprovals?.[0];
    assert.ok(root);
    if (corrupt === 'undefined') root.referenceStage = undefined;
    if (corrupt === 'null') root.referenceStage = null;
    if (corrupt === 'binding') object(root.referenceStage).bindingDigest = 'f'.repeat(64);
    if (corrupt === 'cursor') object(root.referenceStage).cursor = 0;
    if (corrupt === 'prefix') object(root.referenceStage).prefixDigest = 'f'.repeat(64);
    if (corrupt === 'no-references') Reflect.deleteProperty(root, 'references');
    const before = h.bytes();
    assert.deepEqual(await h.invoke(query), { ok: false, code: 'CONFLICT' });
    assert.equal(h.bytes(), before);
  });
test('an empty reference plan acknowledges completion without a stage record or terminal proof', async () => {
  const h = await ownReferenceFixture();
  const bound = object(
    await h.invoke({ ...referencesCommand, inputDigest: h.command.inputDigest }),
  );
  assert.equal(bound.ok, true);
  const before = h.bytes();
  const writes = h.writes();
  assert.deepEqual(
    await h.invoke({
      ...query,
      action: 'operation-approval-reference-page',
      inputDigest: h.command.inputDigest,
      cursor: 0,
    }),
    bound,
  );
  assert.equal(h.bytes(), before);
  assert.equal(h.writes(), writes);
  assert.equal(h.rows.catalogDetailApprovals?.length, 1);
});
test('deadline crossed after image reads refuses the complete private page before any writes', async () => {
  const h = await ownReferencePageFixture();
  const realNow = Date.now;
  const inTime = realNow();
  let checks = 0;
  const before = h.bytes();
  const writes = h.writes();
  try {
    Date.now = () => (++checks === 1 ? inTime : inTime + 3600001);
    assert.deepEqual(await h.invoke(h.pageCommand), { ok: false, code: 'APPROVAL_EXPIRED' });
    assert.ok(checks >= 3);
    assert.equal(h.bytes(), before);
    assert.equal(h.writes(), writes);
  } finally {
    Date.now = realNow;
  }
});
test('reference-page planner includes its image write in a four-operation remaining window', async () => {
  const h = await ownReferencePageFixture(2);
  const plan = buildCatalogImageReferencePlan(h.key, [], h.ids);
  let reads = 0;
  const before = h.bytes();
  const result = await planOwnedReferenceStagePage(
    {
      get: async (c, id) => {
        reads++;
        return h.tx.get(c, id);
      },
      set: async () => {
        throw Error('read-only planning wrote a row');
      },
    },
    plan,
    0,
    4,
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.nextCursor, 1);
  assert.equal(result.images.length, 1);
  assert.equal(result.documentOperations, 4);
  assert.equal(reads, 3);
  assert.equal(h.bytes(), before);
});
test('reference-page commits a bounded prefix before an expensive next image and reads none of its proofs', async () => {
  const h = await ownReferencePageFixture(2);
  const first = h.rows.images?.[0];
  const second = h.rows.images?.[1];
  assert.ok(first && second);
  const plans = (imageId: string, count: number, offset: number) =>
    Array.from({ length: count }, (_, i) =>
      buildCatalogImageReferencePlan((i + offset).toString(16).padStart(64, '0'), [], [imageId]),
    );
  const firstPlans = plans(first._id, 49, 500);
  const secondPlans = plans(second._id, 80, 1000);
  first.catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: firstPlans.map((plan) => catalogImageReferenceEntry(plan, 0)),
  };
  second.catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: secondPlans.map((plan) => catalogImageReferenceEntry(plan, 0)),
  };
  const expensive = new Set(secondPlans.map((plan) => plan.proof._id));
  const get = h.tx.get;
  let forbiddenProofReads = 0;
  let imageReads = 0;
  h.tx.get = async (c, id) => {
    if (c === 'images') imageReads++;
    if (expensive.has(id)) forbiddenProofReads++;
    return get(c, id);
  };
  const oldSecond = structuredClone(second);
  const result = object(await h.invoke(h.pageCommand));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(object(object(result.record).referenceStage).cursor, 1);
  assert.equal(imageReads, 2);
  assert.equal(forbiddenProofReads, 0);
  assert.deepEqual(h.rows.images?.[1], oldSecond);
  assert.equal(h.rows.products?.[0]?.published, false);
});

for (const field of ['imageIds', 'proof', 'health', 'prefixDigest', 'published'])
  test(`reference-page accepts no client-supplied ${field} evidence`, async () => {
    const h = await ownReferencePageFixture();
    const before = h.bytes();
    const result = object(await h.invoke({ ...h.pageCommand, [field]: 'client-assertion' }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(object(result.validation).issues));
    assert.equal(h.bytes(), before);
  });
test('the legacy HTTP workflow refuses an internal reference-page command', async () => {
  let persisted = 0;
  const result = await runCatalogApprovalWorkflow(
    {
      get: async () => ({ _id: 'admin', role: 'admin' }),
      persist: async () => {
        persisted++;
        throw Error('internal page entered HTTP workflow');
      },
    },
    'admin',
    {
      ...query,
      action: 'operation-approval-reference-page',
      inputDigest: 'a'.repeat(64),
      cursor: 0,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(persisted, 0);
});

test('private staging preserves an already committed peer reference while adding no public count for itself', async () => {
  const h = await ownReferencePageFixture();
  const image = h.rows.images?.[0];
  assert.ok(image);
  const peer = buildCatalogImageReferencePlan('f'.repeat(64), [], [image._id]);
  image.catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: [catalogImageReferenceEntry(peer, 0)],
  };
  h.rows.catalogDetailApprovals?.push(peer.proof);
  const result = object(await h.invoke(h.pageCommand));
  assert.equal(result.ok, true, JSON.stringify(result));
  const current = h.rows.images?.[0];
  assert.ok(current);
  assert.equal(current.publishedRefCount, 1);
  const own = buildCatalogImageReferencePlan(h.key, [], h.ids);
  assert.deepEqual(object(current.catalogPublishedReferenceLedger).pending, [
    catalogImageReferenceEntry(own, 0),
  ]);
  const read = await runCatalogImageReferenceRead(h.tx, { action: 'read', imageId: image._id });
  assert.ok(read.state === 'counted');
  assert.equal(read.effectiveCount, 1);
  assert.equal(h.rows.products?.[0]?.published, false);
});
test('reference-page reserves both pixel reads and counts a refused next-image point read', async () => {
  const h = await ownReferencePageFixture(2);
  const first = h.rows.images?.[0];
  const second = h.rows.images?.[1];
  assert.ok(first && second);
  const pending = (id: string, count: number, offset: number) =>
    Array.from({ length: count }, (_, i) =>
      buildCatalogImageReferencePlan((i + offset).toString(16).padStart(64, '0'), [], [id]),
    );
  const firstPlans = pending(first._id, 49, 500);
  const secondPlans = pending(second._id, 34, 1000);
  first.catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: firstPlans.map((p) => catalogImageReferenceEntry(p, 0)),
  };
  second.catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: secondPlans.map((p) => catalogImageReferenceEntry(p, 0)),
  };
  const forbidden = new Set(secondPlans.map((p) => p.proof._id));
  let reads = 0;
  let forbiddenReads = 0;
  const before = h.bytes();
  const plan = buildCatalogImageReferencePlan(h.key, [], h.ids);
  const result = await planOwnedReferenceStagePage(
    {
      get: async (c, id) => {
        reads++;
        if (forbidden.has(id)) forbiddenReads++;
        return h.tx.get(c, id);
      },
      set: async () => {
        throw Error('planning wrote a row');
      },
    },
    plan,
    0,
    90,
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.nextCursor, 1);
  assert.equal(result.images.length, 1);
  assert.equal(result.documentOperations, 54);
  assert.equal(reads, 53);
  assert.equal(forbiddenReads, 0);
  assert.equal(h.bytes(), before);
});

async function ownPublishFixture(
  extra: Record<string, unknown> = {},
  imageCount = 1,
  submittedInputDigest?: string,
) {
  const h = await ownReferencePageFixture(
    imageCount,
    {
      description: 'Ready description',
      ...extra,
    },
    submittedInputDigest,
  );
  let cursor = 0;
  while (cursor < imageCount) {
    const staged = object(await h.invoke({ ...h.pageCommand, cursor }));
    assert.equal(staged.ok, true, JSON.stringify(staged));
    cursor = Number(object(object(staged.record).referenceStage).cursor);
  }
  const { cursor: _cursor, ...scope } = h.pageCommand;
  return { ...h, finishCommand: { ...scope, action: 'operation-publish' } };
}
for (const count of [1, 27])
  test(`owned publish commits product root and unique reference proof together for${count} images`, async () => {
    const h = await ownPublishFixture({}, count);
    const before = h.writes();
    const answer = object(await h.invoke(h.finishCommand));
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const root = object(answer.record);
    assert.equal(root.state, 'complete');
    assert.equal(answer.current, true);
    assert.equal(answer.revisionCurrent, true);
    assert.equal(h.product.published, false, 'original input snapshot remains unchanged');
    const product = h.rows.products?.[0];
    assert.ok(product);
    assert.equal(product.published, true);
    assert.equal(product.catalogLifecycleVersion, 2);
    assert.equal(
      product.catalogDetailPublication && object(product.catalogDetailPublication).revision,
      root.revision,
    );
    assert.equal(object(product.catalogDetailApprovalReceipt).operationId, uuid);
    assert.equal(object(product.catalogDetailApprovalReceipt).actorId, 'admin');
    assert.equal(object(root.completion).published, true);
    assert.equal(h.writes() - before, 3);
    assert.equal(
      h.rows.catalogDetailApprovals?.filter(
        (row) => row.kind === 'catalog-image-reference-commit-v1',
      ).length,
      1,
    );
    for (const id of h.ids) {
      const effective = await runCatalogImageReferenceRead(h.tx, { action: 'read', imageId: id });
      assert.ok(effective.state === 'counted');
      assert.equal(effective.effectiveCount, 1);
      assert.equal(effective.image.publishedRefCount, 0);
    }
    const bytes = h.bytes();
    assert.deepEqual(await h.invoke(h.finishCommand), answer);
    assert.equal(h.bytes(), bytes);
    assert.equal(h.writes() - before, 3);
    const queried = object(await h.invoke(query));
    assert.equal(object(queried.record).state, 'complete');
    assert.equal(queried.current, true);
    assert.equal(h.bytes(), bytes);
  });

test('own publication requires the last private reference page and never trusts client completion', async () => {
  const h = await ownReferencePageFixture(27, { description: 'Ready' });
  assert.equal(object(await h.invoke(h.pageCommand)).ok, true);
  const { cursor: _cursor, ...scope } = h.pageCommand;
  const command = { ...scope, action: 'operation-publish' };
  const before = h.bytes();
  assert.deepEqual(await h.invoke(command), { ok: false, code: 'SOURCE_NOT_READY' });
  assert.equal(h.bytes(), before);
  assert.equal(object(await h.invoke({ ...command, complete: true })).ok, false);
  assert.equal(h.bytes(), before);
});
for (const kind of ['commit', 'cancel', 'wrong'] as const)
  test(`own publication cannot replace an existing ${kind} proof slot`, async () => {
    const h = await ownPublishFixture();
    const plan = buildCatalogImageReferencePlan(h.key, [], h.ids);
    h.rows.catalogDetailApprovals?.push(
      kind === 'cancel'
        ? catalogImageReferenceCancelProof(plan.proof)
        : kind === 'wrong'
          ? { ...plan.proof, leafCount: 2 }
          : plan.proof,
    );
    const before = h.bytes();
    assert.deepEqual(await h.invoke(h.finishCommand), { ok: false, code: 'CONFLICT' });
    assert.equal(h.bytes(), before);
  });
for (const kind of [
  'disabled',
  'archived',
  'edited',
  'classified',
  'identity',
  'revoked',
  'cancelled',
  'expired',
  'media',
  'progress',
  'saved',
] as const)
  test(`own publication refuses ${kind} after reference staging without a partial success`, async () => {
    const h = await ownPublishFixture();
    const product = h.rows.products?.[0];
    const root = h.rows.catalogDetailApprovals?.find((row) => row._id === h.key);
    assert.ok(product && root);
    if (kind === 'disabled')
      product.catalogLifecycleVersion = Number(product.catalogLifecycleVersion) + 1;
    if (kind === 'archived') product.archived = true;
    if (kind === 'edited') product.name = 'Unreviewed';
    if (kind === 'classified') product.catalogClassificationRevision = 1;
    if (kind === 'identity') product.alibabaPrimarySourceKey = 'other';
    if (kind === 'revoked') object(h.rows.users?.[0]).status = 'suspended';
    if (kind === 'cancelled')
      assert.equal(
        object(await h.invoke({ ...h.finishCommand, action: 'operation-cancel' })).ok,
        true,
      );
    if (kind === 'expired') root.createdAt = new Date(Date.now() - 3600001).toISOString();
    if (kind === 'media') object(product.catalogPreparationReport).state = 'blocked';
    if (kind === 'progress') object(root.referenceStage).cursor = 0;
    if (kind === 'saved') Reflect.deleteProperty(root, 'media');
    const before = h.bytes();
    assert.equal(object(await h.invoke(h.finishCommand)).ok, false);
    assert.equal(h.bytes(), before);
    assert.equal(product.published, false);
    assert.equal(
      h.rows.catalogDetailApprovals?.some(
        (row) => row.kind === 'catalog-image-reference-commit-v1',
      ),
      false,
    );
  });
for (const patch of [{ productFamily: undefined }, { description: '' }])
  test(`own publication validates current website fields ${JSON.stringify(patch)} before all writes`, async () => {
    const h = await ownPublishFixture(patch);
    const before = h.bytes();
    const result = object(await h.invoke(h.finishCommand));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'VALIDATION_ERROR');
    assert.equal(h.bytes(), before);
  });
test('a committed own operation is historical after withdrawal and cannot republish by replay', async () => {
  const h = await ownPublishFixture();
  assert.equal(object(await h.invoke(h.finishCommand)).ok, true);
  const product = h.rows.products?.[0];
  assert.ok(product);
  product.published = false;
  product.catalogLifecycleVersion = Number(product.catalogLifecycleVersion) + 1;
  const before = h.bytes();
  const result = object(await h.invoke(h.finishCommand));
  assert.equal(result.ok, true);
  assert.equal(object(result.record).state, 'complete');
  assert.equal(result.current, false);
  assert.equal(h.bytes(), before);
  assert.deepEqual(await h.invoke({ ...h.finishCommand, action: 'operation-cancel' }), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(h.bytes(), before);
});
for (const corrupt of [
  'missing-proof',
  'cancel-proof',
  'wrong-proof',
  'completion',
  'unfinished-page',
  'variant-count',
  'unfinished-reference',
  'cancelled-root',
  'undefined-completion',
])
  test(`completed own publication refuses corrupted ${corrupt} instead of inventing success`, async () => {
    const h = await ownPublishFixture();
    assert.equal(object(await h.invoke(h.finishCommand)).ok, true);
    const plan = buildCatalogImageReferencePlan(h.key, [], h.ids);
    const root = object(h.rows.catalogDetailApprovals?.find((row) => row._id === h.key));
    if (corrupt === 'unfinished-page') root.nextPage = 0;
    if (corrupt === 'variant-count')
      root.variantIds = [...h.command.prepared.variantIds, 'unexpected'];
    if (corrupt === 'unfinished-reference') {
      const binding = object(root.references);
      root.referenceStage = ownedReferenceStageProgress(
        {
          kind: 'catalog-owned-approval-references-v1',
          operationRootId: String(binding.operationRootId),
          treeRoot: String(binding.treeRoot),
          leafCount: Number(binding.leafCount),
          bindingDigest: String(binding.bindingDigest),
        },
        plan,
        0,
      );
    }
    if (corrupt === 'cancelled-root') object(root.operation).cancelledAt = new Date().toISOString();
    if (corrupt === 'undefined-completion') root.completion = undefined;
    if (corrupt === 'missing-proof')
      h.rows.catalogDetailApprovals =
        h.rows.catalogDetailApprovals?.filter((row) => row._id !== plan.proof._id) ?? [];
    if (corrupt === 'cancel-proof')
      Object.assign(
        object(h.rows.catalogDetailApprovals?.find((row) => row._id === plan.proof._id)),
        catalogImageReferenceCancelProof(plan.proof),
      );
    if (corrupt === 'wrong-proof')
      object(h.rows.catalogDetailApprovals?.find((row) => row._id === plan.proof._id)).treeRoot =
        'f'.repeat(64);
    if (corrupt === 'completion')
      Reflect.deleteProperty(
        object(h.rows.catalogDetailApprovals?.find((row) => row._id === h.key)),
        'completion',
      );
    const before = h.bytes();
    assert.deepEqual(await h.invoke(h.finishCommand), { ok: false, code: 'CONFLICT' });
    assert.deepEqual(await h.invoke(query), { ok: false, code: 'CONFLICT' });
    assert.equal(h.bytes(), before);
  });

test('own publication rechecks the original deadline after media reads before any writes', async () => {
  const h = await ownPublishFixture();
  const before = h.bytes();
  const realNow = Date.now;
  const at = realNow();
  const get = h.tx.get;
  let late = false;
  let productReads = 0;
  try {
    h.tx.get = async (collection, id) => {
      const row = await get(collection, id);
      if (collection === 'products' && ++productReads === 2) late = true;
      return row;
    };
    Date.now = () => (late ? at + 3600001 : at);
    const result = object(await h.invoke(h.finishCommand));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'APPROVAL_EXPIRED');
    assert.equal(h.bytes(), before);
  } finally {
    h.tx.get = get;
    Date.now = realNow;
  }
});
test('a complete receipt stays readable after its original deadline without redoing publication', async () => {
  const h = await ownPublishFixture();
  assert.equal(object(await h.invoke(h.finishCommand)).ok, true);
  const realNow = Date.now;
  const at = realNow();
  try {
    Date.now = () => at + 3600001;
    const before = h.bytes();
    const result = object(await h.invoke(h.finishCommand));
    assert.equal(result.ok, true);
    assert.equal(object(result.record).state, 'complete');
    assert.equal(result.expired, true);
    assert.equal(h.bytes(), before);
  } finally {
    Date.now = realNow;
  }
});

for (const reason of ['changed', 'removed'])
  test(`own publication cannot silently approve a pending supplier ${reason} review`, async () => {
    const h = await ownPublishFixture();
    const product = h.rows.products?.[0];
    assert.ok(product);
    product.alibabaReviewPending = true;
    product.alibabaReviewReason = reason;
    const before = h.bytes();
    assert.deepEqual(await h.invoke(h.finishCommand), { ok: false, code: 'SOURCE_NOT_READY' });
    assert.equal(h.bytes(), before);
  });

function trustedRecoveryCommand(h: Awaited<ReturnType<typeof ownPublishFixture>>) {
  return {
    ...query,
    action: 'operation-recover',
    operationRootId: h.key,
    inputDigest: h.finishCommand.inputDigest,
  };
}
test('trusted recovery leaves a healthy original operation available to its owner without writes', async () => {
  const h = await ownPublishFixture();
  const before = h.bytes();
  const result = object(await h.invoke(trustedRecoveryCommand(h), 'other'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovery, 'not-needed');
  assert.equal(h.bytes(), before);
  assert.equal(object(await h.invoke(h.finishCommand)).ok, true);
});
for (const reason of [
  'expired',
  'suspended',
  'member',
  'missing-owner',
  'content-changed',
  'lifecycle-changed',
  'revision-changed',
])
  test(`trusted recovery cancels only the original ${reason} operation and releases its own pending reference`, async () => {
    const h = await ownPublishFixture();
    const root = object(h.rows.catalogDetailApprovals?.find((row) => row._id === h.key));
    const product = h.rows.products?.[0];
    assert.ok(product);
    if (reason === 'expired') root.createdAt = new Date(Date.now() - 3600001).toISOString();
    if (reason === 'suspended') object(h.rows.users?.[0]).status = 'suspended';
    if (reason === 'member') object(h.rows.users?.[0]).role = 'member';
    if (reason === 'missing-owner')
      h.rows.users = h.rows.users?.filter((row) => row._id !== 'admin') ?? [];
    if (reason === 'content-changed') product.name = 'New input';
    if (reason === 'lifecycle-changed')
      product.catalogLifecycleVersion = Number(product.catalogLifecycleVersion) + 1;
    if (reason === 'revision-changed') product.updatedAt = new Date(Date.now() + 10).toISOString();
    const productBefore = structuredClone(product);
    const imageBefore = structuredClone(h.rows.images);
    const result = object(await h.invoke(trustedRecoveryCommand(h), 'other'));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.recovery, 'cancelled');
    const record = object(result.record);
    assert.equal(record.actorId, 'admin');
    const operation = object(record.operation);
    assert.equal(typeof operation.cancelledAt, 'string');
    const audit = object(operation.recovery);
    assert.equal(audit.actorId, 'other');
    assert.equal(
      audit.reason,
      reason === 'expired'
        ? 'expired'
        : ['suspended', 'member', 'missing-owner'].includes(reason)
          ? 'owner-unavailable'
          : 'input-changed',
    );
    assert.equal(typeof audit.at, 'string');
    assert.deepEqual(h.rows.products?.[0], productBefore);
    assert.deepEqual(h.rows.images, imageBefore, 'recovery does not rewrite images or their peers');
    const effective = await runCatalogImageReferenceRead(h.tx, {
      action: 'read',
      imageId: h.ids[0] ?? '',
    });
    assert.ok(effective.state === 'counted');
    assert.equal(effective.effectiveCount, 0);
    assert.equal(
      h.rows.catalogDetailApprovals?.filter(
        (row) => row.kind === 'catalog-image-reference-cancel-v1',
      ).length,
      1,
    );
    const before = h.bytes();
    const repeated = object(await h.invoke(trustedRecoveryCommand(h), 'other'));
    assert.equal(repeated.ok, true);
    assert.equal(repeated.recovery, 'already-cancelled');
    assert.equal(h.bytes(), before);
  });
test('trusted recovery does not flip an expired completed publication even when its owner was revoked', async () => {
  const h = await ownPublishFixture();
  assert.equal(object(await h.invoke(h.finishCommand)).ok, true);
  const root = object(h.rows.catalogDetailApprovals?.find((row) => row._id === h.key));
  root.createdAt = new Date(Date.now() - 3600001).toISOString();
  object(h.rows.users?.[0]).status = 'suspended';
  const before = h.bytes();
  const result = object(await h.invoke(trustedRecoveryCommand(h), 'other'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovery, 'already-complete');
  assert.equal(object(result.record).state, 'complete');
  assert.equal(h.bytes(), before);
  assert.equal(h.rows.products?.[0]?.published, true);
  const effective = await runCatalogImageReferenceRead(h.tx, {
    action: 'read',
    imageId: h.ids[0] ?? '',
  });
  assert.ok(effective.state === 'counted');
  assert.equal(effective.effectiveCount, 1);
});
test('an already cancelled operation is a read-only trusted recovery without replacing its audit', async () => {
  const h = await ownPublishFixture();
  assert.equal(object(await h.invoke({ ...h.finishCommand, action: 'operation-cancel' })).ok, true);
  const before = h.bytes();
  const result = object(await h.invoke(trustedRecoveryCommand(h), 'other'));
  assert.equal(result.ok, true);
  assert.equal(result.recovery, 'already-cancelled');
  assert.equal(h.bytes(), before);
});
for (const actor of ['guest', 'suspended-reviewer'])
  test(`trusted recovery refuses current requester ${actor}`, async () => {
    const h = await ownPublishFixture();
    if (actor === 'suspended-reviewer')
      h.rows.users?.push({ _id: actor, role: 'admin', status: 'suspended' });
    const before = h.bytes();
    assert.deepEqual(await h.invoke(trustedRecoveryCommand(h), actor), {
      ok: false,
      code: 'FORBIDDEN',
    });
    assert.equal(h.bytes(), before);
  });
for (const field of ['productId', 'operationId', 'operationRootId', 'inputDigest'])
  test(`trusted recovery refuses a different ${field} without looking up another owner`, async () => {
    const h = await ownPublishFixture();
    const command = trustedRecoveryCommand(h);
    const before = h.bytes();
    const patch =
      field === 'operationId'
        ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        : field === 'productId'
          ? 'other'
          : 'f'.repeat(64);
    const result = object(await h.invoke({ ...command, [field]: patch }, 'other'));
    assert.equal(result.ok, false);
    assert.equal(h.bytes(), before);
  });
for (const field of ['actorId', 'reason', 'recoveredBy', 'cancelledAt', 'proof'])
  test(`trusted recovery accepts no client-supplied ${field} evidence`, async () => {
    const h = await ownPublishFixture();
    const before = h.bytes();
    assert.equal(
      object(await h.invoke({ ...trustedRecoveryCommand(h), [field]: 'forged' }, 'other')).ok,
      false,
    );
    assert.equal(h.bytes(), before);
  });
test('unknown owner lookup failure is not interpreted as a revoked owner or permission to cancel', async () => {
  const h = await ownPublishFixture();
  const before = h.bytes();
  const get = h.tx.get;
  try {
    h.tx.get = async (collection, id) => {
      if (collection === 'users' && id === 'admin') throw Error('owner database unavailable');
      return get(collection, id);
    };
    await assert.rejects(
      h.invoke(trustedRecoveryCommand(h), 'other'),
      /owner database unavailable/,
    );
    assert.equal(h.bytes(), before);
  } finally {
    h.tx.get = get;
  }
});
test('a future-dated operation is not treated as expired by trusted recovery', async () => {
  const h = await ownPublishFixture();
  object(h.rows.catalogDetailApprovals?.find((row) => row._id === h.key)).createdAt = new Date(
    Date.now() + 60000,
  ).toISOString();
  const before = h.bytes();
  assert.deepEqual(await h.invoke(trustedRecoveryCommand(h), 'other'), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(h.bytes(), before);
});

test('trusted recovery notices expiry crossed while checking a healthy owner before returning not-needed', async () => {
  const h = await ownPublishFixture();
  const get = h.tx.get;
  const realNow = Date.now;
  const at = realNow();
  let late = false;
  try {
    h.tx.get = async (collection, id) => {
      const row = await get(collection, id);
      if (collection === 'users' && id === 'admin') late = true;
      return row;
    };
    Date.now = () => (late ? at + 3600001 : at);
    const result = object(await h.invoke(trustedRecoveryCommand(h), 'other'));
    assert.equal(result.ok, true);
    assert.equal(result.recovery, 'cancelled');
    assert.equal(object(object(object(result.record).operation).recovery).reason, 'expired');
  } finally {
    h.tx.get = get;
    Date.now = realNow;
  }
});
for (const kind of ['expired', 'owner-unavailable'])
  test(`trusted ${kind} recovery does not read a newly broken supplier`, async () => {
    const h = await ownPublishFixture();
    const root = object(h.rows.catalogDetailApprovals?.find((row) => row._id === h.key));
    if (kind === 'expired') root.createdAt = new Date(Date.now() - 3600001).toISOString();
    else object(h.rows.users?.[0]).status = 'suspended';
    const product = h.rows.products?.[0];
    assert.ok(product);
    product.alibabaPrimarySourceKey = 'broken';
    const get = h.tx.get;
    try {
      h.tx.get = async (collection, id) => {
        if (
          ['alibabaSourceProducts', 'catalogSourceObservations', 'alibabaProductLinks'].includes(
            collection,
          )
        )
          throw Error('broken supplier must not block retirement');
        return get(collection, id);
      };
      assert.equal(
        object(await h.invoke(trustedRecoveryCommand(h), 'other')).recovery,
        'cancelled',
      );
    } finally {
      h.tx.get = get;
    }
  });
for (const kind of ['commit', 'wrong-cancel'])
  test(`trusted recovery cannot overwrite a ${kind} terminal slot`, async () => {
    const h = await ownPublishFixture();
    object(h.rows.catalogDetailApprovals?.find((row) => row._id === h.key)).createdAt = new Date(
      Date.now() - 3600001,
    ).toISOString();
    const plan = buildCatalogImageReferencePlan(h.key, [], h.ids);
    h.rows.catalogDetailApprovals?.push(
      kind === 'commit'
        ? plan.proof
        : { ...catalogImageReferenceCancelProof(plan.proof), leafCount: 2 },
    );
    const before = h.bytes();
    assert.deepEqual(await h.invoke(trustedRecoveryCommand(h), 'other'), {
      ok: false,
      code: 'CONFLICT',
    });
    assert.equal(h.bytes(), before);
  });
for (const kind of ['undefined', 'undefined-cancelled', 'no-cancel', 'invalid-actor'])
  test(`recovery audit codec refuses stored ${kind} metadata`, async () => {
    const h = await ownPublishFixture();
    const root = object(h.rows.catalogDetailApprovals?.find((row) => row._id === h.key));
    const operation = object(root.operation);
    if (kind === 'undefined' || kind === 'undefined-cancelled') operation.recovery = undefined;
    else
      operation.recovery = {
        actorId: kind === 'invalid-actor' ? '' : 'other',
        reason: 'expired',
        at: new Date().toISOString(),
      };
    if (kind === 'invalid-actor' || kind === 'undefined-cancelled')
      operation.cancelledAt = new Date().toISOString();
    const before = h.bytes();
    assert.deepEqual(await h.invoke(query), { ok: false, code: 'CONFLICT' });
    assert.equal(h.bytes(), before);
  });

test('trusted recovery does not retire an operation when the service clock moves before its creation during checks', async () => {
  const h = await ownPublishFixture();
  const get = h.tx.get;
  const realNow = Date.now;
  const at = realNow();
  let changed = false;
  const before = h.bytes();
  try {
    h.tx.get = async (collection, id) => {
      const row = await get(collection, id);
      if (collection === 'users' && id === 'admin') changed = true;
      return row;
    };
    Date.now = () => (changed ? at - 60000 : at);
    assert.deepEqual(await h.invoke(trustedRecoveryCommand(h), 'other'), {
      ok: false,
      code: 'CONFLICT',
    });
    assert.equal(h.bytes(), before);
  } finally {
    h.tx.get = get;
    Date.now = realNow;
  }
});

test('trusted recovery verifies the immutable proof before reporting an already-complete operation', async () => {
  const h = await ownPublishFixture();
  assert.equal(object(await h.invoke(h.finishCommand)).ok, true);
  h.rows.catalogDetailApprovals =
    h.rows.catalogDetailApprovals?.filter((row) => row._id === h.key) ?? [];
  const before = h.bytes();
  assert.deepEqual(await h.invoke(trustedRecoveryCommand(h), 'other'), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(h.bytes(), before);
});

for (const saved of [false, true]) {
  const phase = saved ? 'saved' : 'reserved';
  test(`trusted recovery retires an expired ${phase} without inventing a reference proof or saving the draft`, async () => {
    const h = await fixture('publish', saved);
    const root = object(h.rows.catalogDetailApprovals?.[0]);
    root.createdAt = new Date(Date.now() - 3600001).toISOString();
    const product = structuredClone(h.rows.products?.[0]);
    const result = object(
      await h.invoke(
        {
          ...query,
          action: 'operation-recover',
          operationRootId: h.key,
          inputDigest: h.command.inputDigest,
        },
        'other',
      ),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.recovery, 'cancelled');
    assert.equal(object(result.record).state, phase);
    assert.equal(object(object(object(result.record).operation).recovery).actorId, 'other');
    assert.equal(h.rows.catalogDetailApprovals?.length, 1);
    assert.deepEqual(h.rows.products?.[0], product);
  });
  test(`trusted recovery leaves a healthy ${phase} operation unchanged`, async () => {
    const h = await fixture('publish', saved);
    const before = h.bytes();
    const result = object(
      await h.invoke(
        {
          ...query,
          action: 'operation-recover',
          operationRootId: h.key,
          inputDigest: h.command.inputDigest,
        },
        'other',
      ),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.recovery, 'not-needed');
    assert.equal(object(result.record).state, phase);
    assert.equal(h.bytes(), before);
  });
}

for (const correction of ['before-creation', 'no-longer-expired'])
  test(`trusted recovery rechecks ${correction} after cancellation proof reads before writing`, async () => {
    const h = await ownPublishFixture();
    const root = object(h.rows.catalogDetailApprovals?.find((row) => row._id === h.key));
    const realNow = Date.now;
    const at = realNow();
    root.createdAt = new Date(at - 7200000).toISOString();
    const get = h.tx.get;
    let corrected = false;
    const before = h.bytes();
    try {
      h.tx.get = async (collection, id) => {
        const row = await get(collection, id);
        if (collection === 'catalogDetailApprovals' && id !== h.key) corrected = true;
        return row;
      };
      Date.now = () =>
        corrected ? at - (correction === 'before-creation' ? 10800000 : 5400000) : at;
      assert.deepEqual(await h.invoke(trustedRecoveryCommand(h), 'other'), {
        ok: false,
        code: 'CONFLICT',
      });
      assert.equal(h.bytes(), before);
    } finally {
      h.tx.get = get;
      Date.now = realNow;
    }
  });

for (const phase of ['staging', 'complete', 'cancelled'] as const)
  test(`bounded operation workflow projects ${phase} without the private root`, async () => {
    const h = await ownPublishFixture();
    if (phase === 'complete') assert.equal(object(await h.invoke(h.finishCommand)).ok, true);
    if (phase === 'cancelled')
      assert.equal(
        object(await h.invoke({ ...h.finishCommand, action: 'operation-cancel' })).ok,
        true,
      );
    const workflow = () =>
      runProductOperationWorkflow(
        { persist: (actor, command) => runProductOperation(h.tx, actor, command) },
        'admin',
        { ...query, action: 'product-operation-get' },
      );
    const before = h.bytes();
    const first = object(await workflow());
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.kind, 'product-operation');
    assert.equal(first.productId, 'p');
    assert.equal(first.state, phase === 'cancelled' ? 'staging' : phase);
    assert.equal('record' in first, false);
    assert.equal('operation' in first, false);
    assert.equal('publication' in first, false);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 4096);
    assert.equal(h.bytes(), before);
    if (phase === 'complete') {
      const receipt = object(first.completion);
      assert.equal(receipt.revision, object(object(await h.invoke(query)).record).revision);
      assert.equal(receipt.published, true);
      assert.equal(first.current, true);
      object(h.rows.products?.[0]).published = false;
      const historical = object(await workflow());
      assert.equal(historical.state, 'complete');
      assert.deepEqual(historical.completion, first.completion);
      assert.equal(historical.current, false);
      assert.equal(object(h.rows.products?.[0]).published, false);
    }
    if (phase === 'cancelled') assert.equal(typeof first.cancelledAt, 'string');
  });

test('status projects a large saved private operation into a bounded read-only response', async () => {
  const h = await fixture('publish', true, true);
  const before = h.bytes();
  const result = object(
    await runProductOperationWorkflow(
      { persist: (actor, command) => runProductOperation(h.tx, actor, command) },
      'admin',
      { ...query, action: 'product-operation-get' },
    ),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state, 'saved');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
  assert.equal('values' in result, false);
  assert.equal('snapshot' in result, false);
  assert.equal(h.bytes(), before);
});

for (const field of ['actorId', 'productId', 'operationId'] as const)
  test(`public status rejects a mismatched persistence ${field} result`, async () => {
    const h = await ownPublishFixture();
    const result = await runProductOperation(h.tx, 'admin', query);
    assert.ok(result.ok);
    const before = h.bytes();
    const projected = await runProductOperationWorkflow(
      {
        persist: async () => ({
          ...result,
          record: {
            ...result.record,
            [field]: field === 'operationId' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'other',
          },
        }),
      },
      'admin',
      { ...query, action: 'product-operation-get' },
    );
    assert.deepEqual(projected, { ok: false, code: 'CONFLICT' });
    assert.equal(h.bytes(), before);
  });
test('public status cannot mistake a legacy approval progress receipt for its own operation', async () => {
  const projected = await runProductOperationWorkflow(
    {
      persist: async () => ({
        ok: true,
        jobId: 'legacy',
        revision: 'r1',
        nextPage: 1,
        pages: 1,
        complete: true,
      }),
    },
    'admin',
    { ...query, action: 'product-operation-get' },
  );
  assert.deepEqual(projected, { ok: false, code: 'CONFLICT' });
});
test('public facade freezes nested input before a deferred persistence call', async () => {
  const h = await fixture();
  const product = object(h.rows.products?.[0]);
  let release: () => void = () => {
    throw Error('gate not initialized');
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const command = {
    ...query,
    action: 'product-operation-start',
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    intent: 'save-draft',
    expectedUpdatedAt: product.updatedAt,
    values: { configurationPhotos: { v: ['original-photo'] } },
  };
  const pending = runProductOperationWorkflow(
    {
      persist: async (actor, input) => {
        await gate;
        return runProductOperation(h.tx, actor, input);
      },
    },
    'admin',
    command,
  );
  command.values.configurationPhotos.v[0] = 'late-photo';
  release();
  const result = await pending;
  assert.ok(result.ok, JSON.stringify(result));
  const stored = object(
    h.rows.catalogDetailApprovals?.find((row) => row.operationId === command.operationId),
  );
  assert.deepEqual(object(object(stored.operation).values).configurationPhotos, {
    v: ['original-photo'],
  });
});

test('full reference slots identify only their actual blocked image for trusted server recovery', async () => {
  const h = await ownReferencePageFixture(27);
  const image = h.rows.images?.[0];
  assert.ok(image);
  image.catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: Array.from({ length: 80 }, (_, i) =>
      catalogImageReferenceEntry(
        buildCatalogImageReferencePlan((i + 500).toString(16).padStart(64, '0'), [], [image._id]),
        0,
      ),
    ),
  };
  const before = h.bytes();
  const result = object(await h.invoke(h.pageCommand));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MEDIA_BUSY');
  assert.equal(result.pendingReferenceImageId, image._id);
  assert.equal(h.bytes(), before);
});

async function boundedRecoveryFixture() {
  const h = await ownReferencePageFixture(27);
  const image = h.rows.images?.[0];
  assert.ok(image);
  const own = await runProductOperation(h.tx, 'admin', query);
  assert.ok(own.ok);
  const plans = Array.from({ length: 80 }, (_, i) =>
    buildCatalogImageReferencePlan((i + 500).toString(16).padStart(64, '0'), [], [image._id]),
  );
  image.catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: plans.map((plan) => catalogImageReferenceEntry(plan, 0)),
  };
  for (const plan of plans)
    h.rows.catalogDetailApprovals?.push({
      _id: plan.proof.operationRootId,
      productId: 'peer',
      operationId: uuid,
      operation: { inputDigest: 'a'.repeat(64) },
      references: {
        kind: 'catalog-owned-approval-references-v1',
        operationRootId: plan.proof.operationRootId,
        treeRoot: plan.proof.treeRoot,
        leafCount: plan.proof.leafCount,
        bindingDigest: 'a'.repeat(64),
      },
    });
  const calls: {
    roots: string[];
    recoveries: ApprovalPersistenceCommand[];
    pages: number;
    time: number;
    commands: string[];
  } = { roots: [], recoveries: [], pages: 0, time: 0, commands: [] };
  const store = {
    get: async (collection: string, id: string) => {
      if (collection === 'catalogDetailApprovals') calls.roots.push(id);
      return h.tx.get(collection, id);
    },
    persist: async (
      actor: string,
      command: ApprovalPersistenceCommand,
    ): Promise<ApprovalStageResult> => {
      calls.commands.push(command.action);
      if (command.action === 'operation-approval-reference-page') calls.pages++;
      if (command.action === 'operation-recover') {
        calls.recoveries.push(command);
        return { ...own, recovery: 'not-needed' };
      }
      return runProductOperation(h.tx, actor, command);
    },
  };
  return { h, image, plans, calls, store, now: () => calls.time };
}

test('recovery never starts a page retry after its image read spends the remaining time budget', async () => {
  const f = await boundedRecoveryFixture();
  const original = f.store.get;
  const persist = f.store.persist;
  f.store.persist = async (actor, command) => {
    if (command.action === 'operation-approval-reference-page' && f.calls.pages === 0) {
      f.calls.pages++;
      return { ok: false, code: 'MEDIA_BUSY', pendingReferenceImageId: f.image._id };
    }
    return persist(actor, command);
  };
  const ledger = object(f.image.catalogPublishedReferenceLedger);
  const pending = ledger.pending;
  assert.ok(Array.isArray(pending));
  pending.pop();
  f.store.get = async (c, id) => {
    const row = await original(c, id);
    if (c === 'images') f.calls.time = REFERENCE_RECOVERY_BUDGET_MS + 1;
    return row;
  };
  const before = f.h.bytes();
  const result = await persistOwnedReferencePageWithRecovery(
    f.store,
    'admin',
    f.h.pageCommand,
    undefined,
    f.now,
  );
  assert.equal(result.ok, false);
  assert.equal(f.calls.pages, 1);
  assert.equal(f.calls.recoveries.length, 0);
  assert.equal(f.h.bytes(), before);
});
test('recovery keeps an acknowledged retirement but never starts its next page write after the time budget', async () => {
  const f = await boundedRecoveryFixture();
  const persist = f.store.persist;
  f.store.persist = async (actor, command) => {
    const result = await persist(actor, command);
    if (command.action === 'operation-recover') {
      f.calls.time = REFERENCE_RECOVERY_BUDGET_MS + 1;
      assert.ok(result.ok);
      return { ...result, recovery: 'cancelled' };
    }
    return result;
  };
  const result = await persistOwnedReferencePageWithRecovery(
    f.store,
    'admin',
    f.h.pageCommand,
    undefined,
    f.now,
  );
  assert.equal(result.ok, false);
  assert.equal(f.calls.pages, 1);
  assert.equal(f.calls.recoveries.length, 1);
  assert.ok('referenceRecovery' in result);
  assert.equal(object(result.referenceRecovery).nextOffset, 1);
});

test('bounded recovery checks at most three actual ledger roots and its continuation scans the next three', async () => {
  const f = await boundedRecoveryFixture();
  const before = f.h.bytes();
  const first = await persistOwnedReferencePageWithRecovery(
    f.store,
    'admin',
    f.h.pageCommand,
    undefined,
    f.now,
  );
  assert.ok(!first.ok && 'referenceRecovery' in first);
  assert.equal(object(first.referenceRecovery).nextOffset, 3);
  assert.deepEqual(
    f.calls.roots,
    f.plans.slice(0, 3).map((p) => p.proof.operationRootId),
  );
  assert.equal(f.calls.recoveries.length, 3);
  f.calls.roots = [];
  f.calls.recoveries = [];
  const second = await persistOwnedReferencePageWithRecovery(
    f.store,
    'admin',
    f.h.pageCommand,
    first.referenceRecovery,
    f.now,
  );
  assert.ok(!second.ok && 'referenceRecovery' in second);
  assert.equal(object(second.referenceRecovery).nextOffset, 6);
  assert.deepEqual(
    f.calls.roots,
    f.plans.slice(3, 6).map((p) => p.proof.operationRootId),
  );
  assert.equal(f.h.bytes(), before);
});
for (const changed of ['ledger', 'image', 'digest'])
  test(`bounded recovery resets a ${changed} continuation to the actual current ledger`, async () => {
    const f = await boundedRecoveryFixture();
    const first = await persistOwnedReferencePageWithRecovery(
      f.store,
      'admin',
      f.h.pageCommand,
      undefined,
      f.now,
    );
    assert.ok(!first.ok && 'referenceRecovery' in first);
    const cursor = { ...object(first.referenceRecovery) };
    if (changed === 'ledger') object(f.image.catalogPublishedReferenceLedger).epoch = 5;
    if (changed === 'image') cursor.imageId = 'other-image';
    if (changed === 'digest') cursor.ledgerDigest = 'f'.repeat(64);
    f.calls.roots = [];
    await persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand, cursor, f.now);
    assert.deepEqual(
      f.calls.roots,
      f.plans.slice(0, 3).map((p) => p.proof.operationRootId),
    );
  });
test('bounded recovery tail checks only the remaining entry and wraps its cursor without exceeding the cap', async () => {
  const f = await boundedRecoveryFixture();
  const first = await persistOwnedReferencePageWithRecovery(
    f.store,
    'admin',
    f.h.pageCommand,
    undefined,
    f.now,
  );
  assert.ok(!first.ok && 'referenceRecovery' in first);
  f.calls.roots = [];
  const result = await persistOwnedReferencePageWithRecovery(
    f.store,
    'admin',
    f.h.pageCommand,
    { ...object(first.referenceRecovery), nextOffset: 79 },
    f.now,
  );
  assert.ok(!result.ok && 'referenceRecovery' in result);
  assert.equal(object(result.referenceRecovery).nextOffset, 0);
  assert.deepEqual(f.calls.roots, [f.plans[79]?.proof.operationRootId]);
});
test('a fresh media mutex busy result never triggers root discovery or recovery', async () => {
  const f = await boundedRecoveryFixture();
  f.store.get = async () => {
    throw Error('unexpected root discovery');
  };
  f.store.persist = async () => ({ ok: false, code: 'MEDIA_BUSY' });
  assert.deepEqual(await persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand), {
    ok: false,
    code: 'MEDIA_BUSY',
  });
  assert.deepEqual(f.calls.recoveries, []);
});
for (const hinted of ['unrelated-image', 'image26'])
  test(`a forged or off-page full-slot hint ${hinted} cannot select recovery objects`, async () => {
    const f = await boundedRecoveryFixture();
    const persist = f.store.persist;
    f.store.persist = async (actor, command) =>
      command.action === 'operation-approval-reference-page'
        ? { ok: false, code: 'MEDIA_BUSY', pendingReferenceImageId: hinted }
        : persist(actor, command);
    const before = f.h.bytes();
    assert.deepEqual(
      await persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand),
      { ok: false, code: 'CONFLICT' },
    );
    assert.deepEqual(f.calls.roots, []);
    assert.equal(f.h.bytes(), before);
  });
test('changed own product stops full-slot recovery before unrelated roots are read', async () => {
  const f = await boundedRecoveryFixture();
  const persist = f.store.persist;
  f.store.persist = async (actor, command) =>
    command.action === 'operation-approval-reference-page'
      ? { ok: false, code: 'MEDIA_BUSY', pendingReferenceImageId: f.image._id }
      : persist(actor, command);
  object(f.h.rows.products?.[0]).name = 'Changed during original request';
  const before = f.h.bytes();
  assert.deepEqual(await persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.deepEqual(f.calls.roots, []);
  assert.equal(f.h.bytes(), before);
});
for (const failure of ['root-read', 'recovery-write'])
  test(`unknown ${failure} IO failure propagates instead of authorizing a guessed cancellation`, async () => {
    const f = await boundedRecoveryFixture();
    if (failure === 'root-read') {
      const get = f.store.get;
      f.store.get = async (c, id) => {
        if (c === 'catalogDetailApprovals') throw Error('unknown recovery IO');
        return get(c, id);
      };
    } else {
      const persist = f.store.persist;
      f.store.persist = async (actor, command) => {
        if (command.action === 'operation-recover') throw Error('unknown recovery IO');
        return persist(actor, command);
      };
    }
    const before = f.h.bytes();
    await assert.rejects(
      persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand),
      /unknown recovery IO/,
    );
    assert.equal(f.h.bytes(), before);
    assert.equal(f.calls.pages, 1);
  });
for (const invalid of ['missing', 'different-tree', 'different-count', 'bad-input'])
  test(`bounded recovery preserves ${invalid} candidate roots without creating terminal proofs`, async () => {
    const f = await boundedRecoveryFixture();
    const ids = new Set(f.plans.slice(0, 3).map((p) => p.proof.operationRootId));
    if (invalid === 'missing')
      f.h.rows.catalogDetailApprovals =
        f.h.rows.catalogDetailApprovals?.filter((row) => !ids.has(row._id)) ?? [];
    else
      for (const row of f.h.rows.catalogDetailApprovals ?? [])
        if (ids.has(row._id)) {
          if (invalid === 'bad-input') object(row.operation).inputDigest = 'invalid';
          else
            object(row.references)[invalid === 'different-tree' ? 'treeRoot' : 'leafCount'] =
              invalid === 'different-tree' ? 'f'.repeat(64) : 2;
        }
    const before = f.h.bytes();
    const result = await persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand);
    assert.ok(!result.ok && 'referenceRecovery' in result);
    assert.equal(object(result.referenceRecovery).nextOffset, 3);
    assert.equal(f.calls.recoveries.length, 0);
    assert.equal(f.h.bytes(), before);
  });
for (const cursor of [
  null,
  {},
  { imageId: 'image00', ledgerDigest: 'a'.repeat(64), nextOffset: -1 },
  { imageId: 'image00', ledgerDigest: 'a'.repeat(64), nextOffset: 80 },
  { imageId: 'image00', ledgerDigest: 'a'.repeat(64), nextOffset: 1.5 },
  {
    imageId: 'image00',
    ledgerDigest: 'a'.repeat(64),
    nextOffset: 1,
    operationRootId: 'f'.repeat(64),
  },
])
  test(`untrusted continuation ${JSON.stringify(cursor)} is rejected before persistence`, async () => {
    const f = await boundedRecoveryFixture();
    f.store.persist = async () => {
      throw Error('invalid cursor reached persistence');
    };
    assert.deepEqual(
      await persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand, cursor),
      { ok: false, code: 'VALIDATION_ERROR' },
    );
  });
test('permission loss during recovery stops the batch and never retries the original write', async () => {
  const f = await boundedRecoveryFixture();
  const persist = f.store.persist;
  f.store.persist = async (actor, command) => {
    if (command.action === 'operation-recover') return { ok: false, code: 'FORBIDDEN' };
    return persist(actor, command);
  };
  const before = f.h.bytes();
  assert.deepEqual(await persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand), {
    ok: false,
    code: 'FORBIDDEN',
  });
  assert.equal(f.calls.roots.length, 1);
  assert.equal(f.calls.pages, 1);
  assert.equal(f.h.bytes(), before);
});
test('deadline after a candidate read starts no retirement and keeps that candidate resumable', async () => {
  const f = await boundedRecoveryFixture();
  const get = f.store.get;
  f.store.get = async (c, id) => {
    const row = await get(c, id);
    if (c === 'catalogDetailApprovals') f.calls.time = REFERENCE_RECOVERY_BUDGET_MS + 1;
    return row;
  };
  const result = await persistOwnedReferencePageWithRecovery(
    f.store,
    'admin',
    f.h.pageCommand,
    undefined,
    f.now,
  );
  assert.ok(!result.ok && 'referenceRecovery' in result);
  assert.equal(object(result.referenceRecovery).nextOffset, 0);
  assert.equal(f.calls.recoveries.length, 0);
});
test('a slot released before discovery retries the original page without retiring any root', async () => {
  const f = await boundedRecoveryFixture();
  const persist = f.store.persist;
  f.store.persist = async (actor, command) => {
    if (command.action === 'operation-approval-reference-page' && f.calls.pages === 0) {
      f.calls.pages++;
      return { ok: false, code: 'MEDIA_BUSY', pendingReferenceImageId: f.image._id };
    }
    return persist(actor, command);
  };
  const pending = object(f.image.catalogPublishedReferenceLedger).pending;
  assert.ok(Array.isArray(pending));
  pending.pop();
  const result = await persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand);
  assert.ok(
    result.ok &&
      'record' in result &&
      result.record.state === 'staging' &&
      (result.record.referenceStage?.cursor ?? 0) > 0,
    JSON.stringify(result),
  );
  assert.equal(f.calls.recoveries.length, 0);
  assert.equal(f.calls.pages, 2);
});

for (const field of ['actorId', 'productId', 'operationId', 'inputDigest'])
  test(`reference recovery refuses a mismatched own ${field} snapshot before selecting peers`, async () => {
    const f = await boundedRecoveryFixture();
    const persist = f.store.persist;
    f.store.persist = async (actor, command) => {
      const result = await persist(actor, command);
      if (command.action === 'operation-get' && result.ok && 'record' in result) {
        const record =
          field === 'inputDigest'
            ? {
                ...result.record,
                operation: { ...result.record.operation, inputDigest: 'f'.repeat(64) },
              }
            : {
                ...result.record,
                [field]: field === 'operationId' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'other',
              };
        return { ...result, record };
      }
      return result;
    };
    const before = f.h.bytes();
    assert.deepEqual(
      await persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand),
      { ok: false, code: 'CONFLICT' },
    );
    assert.deepEqual(f.calls.roots, []);
    assert.equal(f.h.bytes(), before);
  });
test('a first page that consumes the entire time budget triggers no discovery or extra request', async () => {
  const f = await boundedRecoveryFixture();
  const persist = f.store.persist;
  f.store.persist = async (actor, command) => {
    const result = await persist(actor, command);
    f.calls.time = REFERENCE_RECOVERY_BUDGET_MS + 1;
    return result;
  };
  const result = await persistOwnedReferencePageWithRecovery(
    f.store,
    'admin',
    f.h.pageCommand,
    undefined,
    f.now,
  );
  assert.ok(!result.ok && result.code === 'MEDIA_BUSY');
  assert.equal(f.calls.pages, 1);
  assert.deepEqual(f.calls.commands, ['operation-approval-reference-page']);
  assert.deepEqual(f.calls.roots, []);
  assert.equal(f.calls.recoveries.length, 0);
});

for (const invalid of ['bad-membership', 'duplicate-root', 'undefined-ledger', 'bad-base'])
  test(`discovery revalidates a concurrently changed ${invalid} image before reading any holder`, async () => {
    const f = await boundedRecoveryFixture();
    const persist = f.store.persist;
    f.store.persist = async (actor, command) =>
      command.action === 'operation-approval-reference-page'
        ? { ok: false, code: 'MEDIA_BUSY', pendingReferenceImageId: f.image._id }
        : persist(actor, command);
    const ledger = object(f.image.catalogPublishedReferenceLedger);
    const pending = ledger.pending;
    assert.ok(Array.isArray(pending));
    if (invalid === 'bad-membership') object(pending[0]).siblings = ['f'.repeat(64)];
    if (invalid === 'duplicate-root') pending[1] = structuredClone(pending[0]);
    if (invalid === 'undefined-ledger') f.image.catalogPublishedReferenceLedger = undefined;
    if (invalid === 'bad-base') f.image.publishedRefCount = '0';
    const before = f.h.bytes();
    assert.deepEqual(
      await persistOwnedReferencePageWithRecovery(f.store, 'admin', f.h.pageCommand),
      { ok: false, code: 'MEDIA_NOT_READY' },
    );
    assert.deepEqual(f.calls.roots, []);
    assert.equal(f.h.bytes(), before);
  });

test('deadline after checking the original operation starts no further image lookup', async () => {
  const f = await boundedRecoveryFixture();
  const persist = f.store.persist;
  f.store.persist = async (actor, command) => {
    const result = await persist(actor, command);
    if (command.action === 'operation-get') f.calls.time = REFERENCE_RECOVERY_BUDGET_MS + 1;
    return result;
  };
  f.store.get = async () => {
    throw Error('image discovery started after deadline');
  };
  const before = f.h.bytes();
  const result = await persistOwnedReferencePageWithRecovery(
    f.store,
    'admin',
    f.h.pageCommand,
    undefined,
    f.now,
  );
  assert.ok(!result.ok && result.code === 'MEDIA_BUSY');
  assert.equal(f.h.bytes(), before);
  assert.deepEqual(f.calls.commands, ['operation-approval-reference-page', 'operation-get']);
});

for (const field of ['submittedInputDigest', 'undefined-submittedInputDigest'])
  test(`normalized operation codec refuses stored ${field} tampering`, async () => {
    const h = await fixture('save-draft', false);
    const command = {
      action: 'operation-start',
      productId: 'p',
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      intent: 'save-draft',
      expectedUpdatedAt: h.rows.products?.[0]?.updatedAt ?? null,
      values: { description: 'Original' },
      submittedInputDigest: 'a'.repeat(64),
    };
    const first = await runProductOperation(h.tx, 'admin', command);
    assert.ok(first.ok);
    const stored = object(
      h.rows.catalogDetailApprovals?.find((row) => row.operationId === command.operationId),
    );
    object(stored.operation).submittedInputDigest =
      field === 'submittedInputDigest' ? 'b'.repeat(64) : undefined;
    const before = h.bytes();
    assert.deepEqual(
      await runProductOperation(h.tx, 'admin', {
        action: 'operation-get',
        productId: 'p',
        operationId: command.operationId,
      }),
      { ok: false, code: 'CONFLICT' },
    );
    assert.equal(h.bytes(), before);
  });
for (const patch of [{ submittedInputDigest: undefined }, { submittedInputDigest: 'invalid' }])
  test(`internal start refuses malformed submitted digest ${Object.keys(patch).join(',')}:${String(patch.submittedInputDigest)}`, async () => {
    const h = await fixture('save-draft', false);
    const before = h.bytes();
    assert.deepEqual(
      await runProductOperation(h.tx, 'admin', {
        action: 'operation-start',
        productId: 'p',
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        intent: 'save-draft',
        expectedUpdatedAt: h.rows.products?.[0]?.updatedAt ?? null,
        values: {},
        ...patch,
      }),
      { ok: false, code: 'VALIDATION_ERROR' },
    );
    assert.equal(h.bytes(), before);
  });

test('submitted digest survives genuine owned pages, media, pending stage, publication and historical replay', async () => {
  const submittedInputDigest = 'a'.repeat(64);
  const h = await ownPublishFixture({}, 1, submittedInputDigest);
  const finished = object(await h.invoke(h.finishCommand));
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.equal(
    object(object(finished.record).operation).submittedInputDigest,
    submittedInputDigest,
  );
  assert.equal(object(finished.record).state, 'complete');
  const before = h.bytes();
  const writes = h.writes();
  assert.deepEqual(await h.invoke(h.finishCommand), finished);
  assert.equal(h.bytes(), before);
  assert.equal(h.writes(), writes);
  object(h.rows.products?.[0]).published = false;
  const afterWithdraw = h.bytes();
  const historical = object(await h.invoke(query));
  assert.equal(historical.current, false);
  assert.equal(
    object(object(historical.record).operation).submittedInputDigest,
    submittedInputDigest,
  );
  assert.equal(object(h.rows.products?.[0]).published, false);
  assert.equal(h.bytes(), afterWithdraw);
});

for (const budget of [0, -1, 12001, Number.NaN])
  test(`reference recovery refuses to start a page with invalid or exhausted budget ${budget}`, async () => {
    const f = await boundedRecoveryFixture();
    const before = f.h.bytes();
    const result = await persistOwnedReferencePageWithRecovery(
      f.store,
      'admin',
      f.h.pageCommand,
      undefined,
      f.now,
      budget,
    );
    assert.ok(!result.ok && result.code === (budget === 0 ? 'MEDIA_BUSY' : 'VALIDATION_ERROR'));
    assert.equal(f.calls.pages, 0);
    assert.equal(f.h.bytes(), before);
  });

test('reference recovery inherits a short parent budget after reading the pending image', async () => {
  const f = await boundedRecoveryFixture();
  const original = f.store.get;
  f.store.get = async (c, id) => {
    const row = await original(c, id);
    if (c === 'images') f.calls.time = 101;
    return row;
  };
  const before = f.h.bytes();
  const result = await persistOwnedReferencePageWithRecovery(
    f.store,
    'admin',
    f.h.pageCommand,
    undefined,
    f.now,
    100,
  );
  assert.equal(result.ok, false);
  assert.equal(f.calls.pages, 1);
  assert.equal(f.calls.recoveries.length, 0);
  assert.equal(f.h.bytes(), before);
});
