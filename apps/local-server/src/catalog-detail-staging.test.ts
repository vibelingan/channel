import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import { catalogApprovalDigest } from '@vibelingan-channel/db/catalog-detail-commit';
import { prepareStagedApproval } from '@vibelingan-channel/db/catalog-detail-staging';
import { approvedVariantDocumentId } from '@vibelingan-channel/db/catalog-detail-storage';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { z } from 'zod';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { getProductDetail } from '../../functions/public-api/src/catalog-detail.ts';
import { JsonFileAdapter } from './json-adapter.ts';

test('durable approval resumes after reload; public paging and RFQ use immutable canonical identities', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-staged-approval-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const variants = Array.from({ length: 21 }, (_, position) => ({
    _id: `v${position}`,
    productId: 'p',
    position,
    sku: `sku-${position}`,
    detailSourceOwner: 'alibaba:source',
    detailSourceRevision: 'source-r1',
    detailSourceMissing: false,
    optionValues: { Color: `Color ${position}` },
    imageIds: ['image'],
    detailSourceCandidate: {
      id: `v${position}`,
      options: [],
      images: [],
      offers: [],
      inventory: { state: 'unknown' },
    },
  }));
  const header = {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'p',
    name: 'Headset',
    images: ['/api/images/image'],
    facts: [],
    offers: [],
  };
  const product = {
    _id: 'p',
    name: 'Headset',
    description: '',
    imageIds: ['image'],
    localDetailClone: true,
    published: false,
    archived: false,
    productFamily: 'headphones',
    detailSourceReady: true,
    detailSourceOwner: 'alibaba:source',
    detailSourceRevision: 'source-r1',
    detailSourceCandidate: header,
    detailSourceManifest: { revision: 'source-r1', variantIds: variants.map((row) => row._id) },
    catalogDetailPublication: { state: 'approved', revision: 'old', header, variantCount: 0 },
  };
  writeFileSync(
    file,
    JSON.stringify({
      products: [product],
      productVariants: variants,
      users: [{ _id: 'admin', role: 'admin' }],
      images: [
        { _id: 'image', status: 'active', storageProvider: 'local-disk', publishedRefCount: 0 },
      ],
    }),
  );
  const prepared = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId: randomUUID(),
      expectedRevision: 'old',
      expectedDigest: catalogApprovalDigest(product, variants),
    },
    product,
    variants,
  );
  assert.ok(prepared.ok);
  let adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const config = { jwtSecret: 'staging-local-test-only', enableDetailApproval: true };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    name: 'Test Admin',
    role: 'admin',
    email: 'admin@example.test',
  });
  const action = 'catalogDetailApproval';
  const reviewInput = { action: 'review', productId: 'p' };
  assert.equal((await handleAdminRequest({ action, data: reviewInput }, config)).ok, false);
  assert.equal(
    (
      await handleAdminRequest(
        { action, token, data: reviewInput },
        { ...config, enableDetailApproval: false },
      )
    ).ok,
    false,
  );
  const review = await handleAdminRequest({ action, token, data: reviewInput }, config);
  assert.ok(review.ok);
  const reviewed = z
    .object({ expectedDigest: z.string(), expectedRevision: z.string().nullable() })
    .parse(review.data);
  assert.equal(reviewed.expectedDigest, catalogApprovalDigest(product, variants));
  assert.doesNotMatch(
    JSON.stringify(review),
    /detailSourceOwner|pageHashes|actorId|privateEvidence/,
  );
  assert.equal(
    (
      await handleAdminRequest(
        { action, token, data: { action: 'begin', prepared: prepared.value } },
        config,
      )
    ).ok,
    false,
    'browser cannot submit a prepared snapshot',
  );
  for (const collection of ['catalogDetailVariants', 'catalogDetailApprovals']) {
    const denied = await handleAdminRequest(
      { action: 'list', token, data: { collection } },
      config,
    );
    assert.ok(!denied.ok, 'even admin cannot use generic CRUD for approval internals');
    assert.equal(denied.error.code, 'FORBIDDEN');
  }
  const call = (data: unknown) => handleAdminRequest({ action, token, data }, config);
  const progress = z.object({
    jobId: z.string(),
    revision: z.string(),
    nextPage: z.number(),
    pages: z.number(),
    complete: z.boolean(),
  });
  const started = await call({
    action: 'begin',
    command: { productId: 'p', operationId: prepared.value.operationId, ...reviewed },
  });
  assert.ok(started.ok);
  const begin = progress.parse(started.data);
  // Real filesystem failure, not just a transaction fake: an uncommitted page
  // must disappear from BOTH memory and the durable cursor after rename fails.
  const beforePage = join(directory, 'before-page.json');
  const failedPage = adapter.persistCatalogDetailApproval('admin', {
    action: 'page',
    jobId: begin.jobId,
    page: 0,
  });
  // Let the write lock load the valid file, before the async transaction's
  // document reads finish. The assertion below pins failure to final rename,
  // so a future scheduling change cannot accidentally test only a failed read.
  await Promise.resolve();
  renameSync(file, beforePage);
  mkdirSync(file);
  try {
    await assert.rejects(
      failedPage,
      (error) => error instanceof Error && 'syscall' in error && error.syscall === 'rename',
    );
  } finally {
    rmSync(file, { recursive: true });
    renameSync(beforePage, file);
  }
  assert.equal((await adapter.get('catalogDetailApprovals', begin.jobId))?.nextPage, 0);
  assert.equal(
    (
      await adapter.list({
        collection: 'catalogDetailVariants',
        page: 1,
        pageSize: 100,
        search: '',
      })
    ).total,
    0,
  );
  const first = await call({
    action: 'page',
    jobId: begin.jobId,
    page: 0,
  });
  assert.ok(first.ok);
  assert.equal(progress.parse(first.data).nextPage, 1);
  assert.equal(progress.parse(first.data).pages, 2);
  adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  assert.equal(
    CatalogDetailPublicationSchema.parse(
      (await adapter.get('products', 'p'))?.catalogDetailPublication,
    ).revision,
    'old',
  );
  assert.equal((await call({ action: 'finish', jobId: begin.jobId })).ok, false);
  assert.equal(
    (
      await call({
        action: 'page',
        jobId: begin.jobId,
        page: 1,
      })
    ).ok,
    true,
  );
  assert.equal((await call({ action: 'finish', jobId: begin.jobId })).ok, true);
  adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  assert.equal((await getProductDetail('p')).ok, false, 'approval never publishes a draft');
  await adapter.update('products', 'p', { published: true });
  await adapter.update('productVariants', 'v20', {
    detailSourceMissing: true,
    optionValues: { Color: 'Unreviewed' },
  });
  const page = await getProductDetail('p', 2, 20, begin.revision);
  assert.ok(page.ok);
  assert.equal(page.data.variants.total, 21);
  assert.equal(page.data.variants.items[0]?.id, 'v20');
  assert.equal(page.data.variants.items[0]?.options[0]?.value, 'Color 20');
  const request = await adapter.submitCatalogQuote({
    idempotencyKey: randomUUID(),
    target: { intent: 'variant_quote', productId: 'p', variantId: 'v20', revision: begin.revision },
    fields: {
      intent: 'variant_quote',
      quantity: '300',
      deliveryDate: '',
      customizationTypes: [],
      brief: '',
      contactName: 'Test Buyer',
      company: 'Test',
      email: 'buyer@example.test',
      country: 'HK',
    },
  });
  assert.ok(request.ok);
  const reopened = new JsonFileAdapter(file);
  const inquiry = await reopened.manageCatalogInquiry('admin', {
    action: 'get',
    id: request.requestId,
  });
  assert.ok(inquiry.ok && inquiry.data.kind === 'detail');
  assert.equal(inquiry.data.item.snapshot.variant?.id, 'v20');
  assert.equal(inquiry.data.item.snapshot.variant?.options[0]?.value, 'Color 20');
  // A missing or misbound copy must be an explicit failure, never an empty successful page.
  const copyId = approvedVariantDocumentId('p', begin.revision, 'v20');
  await adapter.update('catalogDetailVariants', copyId, { variantId: 'v19' });
  assert.equal((await getProductDetail('p', 2, 20, begin.revision)).ok, false);
  await adapter.remove('catalogDetailVariants', copyId);
  assert.equal((await getProductDetail('p', 1, 20, begin.revision)).ok, false);
});
