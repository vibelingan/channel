import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  dianxiaomiObservationAdapter,
  parseDianxiaomiWorkbook,
} from '@vibelingan-channel/catalog-import/dianxiaomi';
import type { CatalogSourceObservation } from '@vibelingan-channel/catalog-import/observations';
import { buildAcceptanceWorkbook } from '@vibelingan-channel/catalog-import/testing/dianxiaomi-acceptance';
import { approveCatalogDetail, createDocWithId, get, updateDoc } from '@vibelingan-channel/db';
import {
  CatalogApprovalManifestSchema,
  catalogApprovalDigest,
} from '@vibelingan-channel/db/catalog-detail-commit';
import { migrateImageLocally } from '@vibelingan-channel/fn-admin/catalog-import-media';
import { getCatalogImage } from '@vibelingan-channel/fn-public-api/handler';
import { handlePublicApiEvent } from '@vibelingan-channel/fn-public-api/http-adapter';
import {
  decodeCatalogDetailView,
  decodeCatalogProductDetail,
} from '@vibelingan-channel/shared/catalog-detail';
import express from 'express';
import {
  approveLocalDetail,
  materializeLocalDetail,
  wireLocalDetailWorkspace,
} from './catalog-detail-workspace.ts';
import { closeServer, registerCatalogRoutes } from './catalog-routes.ts';

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=',
  'base64',
);
let sampleImages = new Map<string, string>();

function observation(
  provider: 'alibaba' | 'dianxiaomi' = 'alibaba',
  count = 3,
): CatalogSourceObservation {
  return {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider,
      sourceProductKey: 'private-product',
      accountKey: 'private-account',
      observedAt: '2026-09-06T00:00:00.000Z',
      captureMode: 'selected',
      completeness: 'full-product',
    },
    identity: { title: 'Sample headset', matchHints: {}, attributes: [] },
    lifecycle: { sourceListingStatus: 'published' },
    content: {
      media: [{ sourceUrl: 'https://example.com/pixel.png', role: 'primary', position: 0 }],
      description: {
        text: 'Sample description',
        sanitized: true,
        placeholder: false,
        provenance: 'description',
      },
    },
    variants: Array.from({ length: count }, (_, i) => ({
      sourceVariantKey: `private-${i}`,
      sku: `SKU-${i}`,
      options: [{ sourceName: 'Color', value: `Color ${i}` }],
      inventory: [],
      media: [],
    })),
    offers: [],
    evidence: [{ kind: 'raw-payload', evidenceId: 'private-evidence' }],
    warnings: [],
  };
}
const materialize = (input: CatalogSourceObservation) =>
  materializeLocalDetail({
    observation: input,
    productFamily: 'headphones',
    images: sampleImages,
  });
const read = (id: string, query = '') =>
  handlePublicApiEvent(
    { httpMethod: 'GET', path: `/api/products/${id}/detail${query}` },
    { enableCatalogDetail: true },
  );

test('description media is opt-in so already open strict clients retain their wire contract', async (t) => {
  await workspace(t);
  const { productId } = await materialize(observation());
  const imageId = sampleImages.get('https://example.com/pixel.png');
  assert.ok(imageId);
  await updateDoc('products', productId, { descriptionImageIds: [imageId] });
  await approveLocalDetail(productId);
  for (const query of ['', '?view=structured', '?view=sections']) {
    const response = await read(productId, query);
    assert.equal(response.statusCode, 200);
    assert.equal(Object.hasOwn(JSON.parse(response.body).data, 'descriptionImages'), false);
  }
  const response = await read(productId, '?view=sections-media');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).data.descriptionImages, [`/api/images/${imageId}`]);
  assert.equal((await read(productId, '?view=sections-media&view=sections')).statusCode, 400);
});

async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'channel-ui02-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = join(directory, 'db.json');
  const media = join(directory, 'media');
  const adapter = wireLocalDetailWorkspace(db, media);
  const image = await migrateImageLocally(
    {
      ok: true,
      bytes: pixel,
      mimeType: 'image/png',
      sha256: createHash('sha256').update(pixel).digest('hex'),
      finalUrl: 'https://example.com/pixel.png',
      dimensions: { width: 1, height: 1 },
    },
    'Synthetic test pixel',
    new Map(),
  );
  sampleImages = new Map([['https://example.com/pixel.png', image.imageId]]);
  return { adapter, reopen: () => wireLocalDetailWorkspace(db, media) };
}

function detail(body: string) {
  const envelope: unknown = JSON.parse(body);
  assert.ok(typeof envelope === 'object' && envelope !== null && 'data' in envelope);
  const decoded = decodeCatalogProductDetail(envelope.data);
  assert.ok(decoded.ok, decoded.ok ? undefined : decoded.errors.join('; '));
  return decoded.value;
}

test('structured content is shared across providers, explicitly opted into, and never follows stale operator text', async (t) => {
  await workspace(t);
  for (const provider of ['alibaba', 'dianxiaomi'] as const) {
    const source = observation(provider);
    source.content.description = {
      text: 'Material ABS',
      sanitizedHtml: '<table><tr><td>Material</td><td>ABS</td></tr></table>',
      sanitized: true,
      placeholder: false,
      provenance: 'description',
    };
    const { productId } = await materialize(source);
    assert.equal((await read(productId, '?view=structured')).statusCode, 404);
    await approveLocalDetail(productId);
    const legacy = detail((await read(productId)).body);
    assert.equal(legacy.schemaVersion, 'catalog-product-detail-v1');
    assert.equal(Object.hasOwn(legacy, 'content'), false);
    const response = await read(productId, '?view=structured');
    const decoded = decodeCatalogDetailView(JSON.parse(response.body).data);
    assert.ok(decoded.ok);
    assert.equal(decoded.value.schemaVersion, 'catalog-product-detail-v2');
    assert.ok('content' in decoded.value);
    assert.deepEqual(decoded.value.content.specifications, [{ name: 'Material', value: 'ABS' }]);
    assert.equal(decodeCatalogProductDetail(decoded.value).ok, false);
    assert.equal(response.body.includes('sanitizedHtml'), false);
    const sectionResponse = await read(productId, '?view=sections');
    const sections = decodeCatalogDetailView(JSON.parse(sectionResponse.body).data);
    assert.ok(sections.ok && sections.value.schemaVersion === 'catalog-product-detail-v3');
    assert.deepEqual(sections.value.noteBlocks, []);
    assert.equal(Object.hasOwn(decoded.value, 'noteBlocks'), false);
    for (const query of ['?view=unknown', '?view=structured&view=structured'])
      assert.equal((await read(productId, query)).statusCode, 400);
    await updateDoc('products', productId, { description: 'Operator changed the description' });
    await approveLocalDetail(productId);
    assert.equal(
      detail((await read(productId, '?view=structured')).body).descriptionText,
      'Operator changed the description',
    );
  }
});

test('canonical identities survive replay and disk reopen; a draft is private until explicitly approved', async (t) => {
  const local = await workspace(t);
  const source = observation();
  const first = await materialize(source);
  assert.equal((await read(first.productId)).statusCode, 404);
  const before = await local.adapter.list({
    collection: 'productVariants',
    page: 1,
    pageSize: 100,
    search: '',
  });
  const reopened = local.reopen();
  assert.equal((await materialize(source)).productId, first.productId);
  const after = await reopened.list({
    collection: 'productVariants',
    page: 1,
    pageSize: 100,
    search: '',
  });
  assert.deepEqual(after.items.map((v) => v._id).sort(), before.items.map((v) => v._id).sort());
  await approveLocalDetail(first.productId);
  const response = await read(first.productId);
  assert.equal(response.statusCode, 200);
  assert.equal(detail(response.body).variants.total, 3);
  for (const secret of [
    'private-account',
    'private-product',
    'private-evidence',
    'sourceVariantKey',
    'detailSource',
  ]) {
    assert.equal(response.body.includes(secret), false);
  }
  assert.equal(
    (await handlePublicApiEvent({ path: `/api/products/${first.productId}/detail` }, {}))
      .statusCode,
    404,
  );
});

test('invalid note blocks fail approval before replacing an already readable snapshot', async (t) => {
  await workspace(t);
  const { productId } = await materialize(observation());
  await approveLocalDetail(productId);
  const before = detail((await read(productId)).body);
  await updateDoc('products', productId, {
    detailSourceContentCandidate: {
      schemaVersion: 'catalog-content-v1',
      specifications: [],
      packaging: [],
      notes: ['Approved note'],
    },
    detailSourceNoteBlocksCandidate: [{ kind: 'heading', text: 'Different note' }],
  });
  await assert.rejects(() => approveLocalDetail(productId));
  const after = await read(productId);
  assert.equal(after.statusCode, 200);
  assert.deepEqual(detail(after.body), before);
});

test('formal approval adapter persists both providers atomically, remains private, and survives file reopen', async (t) => {
  const { reopen } = await workspace(t);
  await createDocWithId('users', 'approval-admin', { role: 'admin', username: 'Test approver' });
  for (const provider of ['alibaba', 'dianxiaomi'] as const) {
    const { productId } = await materialize(observation(provider));
    const product = await get('products', productId);
    assert.ok(product);
    const manifest = CatalogApprovalManifestSchema.parse(product.detailSourceManifest);
    const variants = await Promise.all(
      manifest.variantIds.map(async (id) => {
        const row = await get('productVariants', id);
        assert.ok(row);
        return row;
      }),
    );
    const command = {
      productId,
      operationId: randomUUID(),
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, variants),
    };
    const [first, other] = await Promise.all([
      approveCatalogDetail('approval-admin', command),
      approveCatalogDetail('approval-admin', { ...command, operationId: randomUUID() }),
    ]);
    assert.ok(first.ok && !first.replayed);
    assert.deepEqual(other, { ok: false, code: 'CONFLICT' });
    reopen();
    assert.equal((await get('products', productId))?.published, false);
    assert.equal((await read(productId)).statusCode, 404, 'approval is not permission to publish');
    for (const id of manifest.variantIds)
      assert.equal((await get('productVariants', id))?.catalogDetailRevision, first.revision);
    const retry = await approveCatalogDetail('approval-admin', command);
    assert.ok(retry.ok && retry.replayed);
  }
});

test('a forged candidate identity cannot overwrite another product variant during approval', async (t) => {
  await workspace(t);
  const a = await materialize(observation('alibaba', 1));
  const b = await materialize(observation('dianxiaomi', 1));
  await approveLocalDetail(a.productId);
  await approveLocalDetail(b.productId);
  const first = detail((await read(a.productId)).body);
  const second = detail((await read(b.productId)).body);
  const sourceVariant = first.variants.items[0];
  const targetVariant = second.variants.items[0];
  assert.ok(sourceVariant && targetVariant);
  const untouched = await get('productVariants', targetVariant.id);
  await updateDoc('productVariants', sourceVariant.id, {
    detailSourceCandidate: { ...sourceVariant, id: targetVariant.id },
  });
  await assert.rejects(() => approveLocalDetail(a.productId));
  assert.deepEqual(await get('productVariants', targetVariant.id), untouched);
  assert.deepEqual(detail((await read(a.productId)).body), first);
  assert.deepEqual(detail((await read(b.productId)).body), second);
});

test('both providers use the same real HTTP route and different canonical identities despite identical source keys/SKUs', async (t) => {
  await workspace(t);
  const a = await materialize(observation('alibaba'));
  const b = await materialize(observation('dianxiaomi'));
  assert.notEqual(a.productId, b.productId);
  await approveLocalDetail(a.productId);
  await approveLocalDetail(b.productId);
  const app = express();
  registerCatalogRoutes(app, 'products', '/api/products', { enableCatalogDetail: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  for (const id of [a.productId, b.productId]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/products/${id}/detail`);
    assert.equal(response.status, 200);
    assert.equal(detail(await response.text()).variants.total, 3);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  // /products/slug/detail is the existing slug route, not the new detail
  // route for an imaginary product whose canonical ID is "slug".
  await updateDoc('products', a.productId, { slug: 'detail' });
  const slugResponse = await fetch(`http://127.0.0.1:${address.port}/api/products/slug/detail`);
  assert.equal(slugResponse.status, 200);
  const slugEnvelope = await slugResponse.json();
  assert.ok(typeof slugEnvelope === 'object' && slugEnvelope !== null && 'data' in slugEnvelope);
  assert.ok(
    typeof slugEnvelope.data === 'object' &&
      slugEnvelope.data !== null &&
      '_id' in slugEnvelope.data,
  );
  assert.equal(slugEnvelope.data._id, a.productId);
});

test('51 variants span explicit stable pages; revision mismatch and corrupt pagination fail', async (t) => {
  await workspace(t);
  const product = await materialize(observation('alibaba', 51));
  await approveLocalDetail(product.productId);
  const first = detail((await read(product.productId)).body);
  const second = detail((await read(product.productId, `?page=2&revision=${first.revision}`)).body);
  assert.equal(first.variants.items.length, 50);
  assert.equal(first.variants.hasMore, true);
  assert.equal(second.variants.items.length, 1);
  assert.equal(second.variants.hasMore, false);
  assert.equal(
    new Set([...first.variants.items, ...second.variants.items].map((v) => v.id)).size,
    51,
  );
  for (const query of [
    '?page=-1',
    '?page=2bad',
    '?pageSize=51',
    '?pageSize=0',
    '?page=9007199254740992',
  ]) {
    assert.equal((await read(product.productId, query)).statusCode, 400);
  }
  await approveLocalDetail(product.productId);
  assert.equal(
    (await read(product.productId, `?page=2&revision=${first.revision}`)).statusCode,
    409,
  );
});

test('source replay preserves manual fields, NEW/review flags and the approved snapshot', async (t) => {
  await workspace(t);
  const source = observation();
  const result = await materialize(source);
  await approveLocalDetail(result.productId);
  const before = detail((await read(result.productId)).body);
  const id = before.variants.items[0]?.id;
  assert.ok(id);
  await updateDoc('products', result.productId, {
    name: 'Edited name',
    reviewState: 'pending',
    isNew: true,
  });
  await updateDoc('productVariants', id, {
    sku: 'MANUAL-SKU',
    optionValues: { Color: 'Operator blue' },
  });
  source.identity.title = 'New supplier title';
  source.source.observedAt = '2026-09-06T01:00:00.000Z';
  const sourceVariant = source.variants[0];
  assert.ok(sourceVariant);
  sourceVariant.sku = 'NEW-SOURCE';
  await materialize(source);
  assert.deepEqual(detail((await read(result.productId)).body), before);
  const product = await get('products', result.productId);
  assert.equal(product?.name, 'Edited name');
  assert.equal(product?.published, true);
  assert.equal(product?.reviewState, 'pending');
  assert.equal(product?.isNew, true);
  assert.equal((await get('productVariants', id))?.sku, 'MANUAL-SKU');
  await approveLocalDetail(result.productId);
  const approved = detail((await read(result.productId)).body);
  assert.equal(approved.name, 'Edited name');
  assert.equal(approved.variants.items[0]?.sku, 'MANUAL-SKU');
  assert.deepEqual(approved.variants.items[0]?.options, [
    { name: 'Color', value: 'Operator blue' },
  ]);
});

test('removed source variants do not delete manual/other-source variants, and take effect only on approval', async (t) => {
  await workspace(t);
  const source = observation();
  const product = await materialize(source);
  await approveLocalDetail(product.productId);
  const before = detail((await read(product.productId)).body);
  await createDocWithId('productVariants', 'manual', {
    productId: product.productId,
    sku: 'MANUAL',
    detailSourceOwner: 'another-owner',
  });
  source.variants = [];
  source.source.observedAt = '2026-09-06T01:00:00.000Z';
  await materialize(source);
  assert.equal(detail((await read(product.productId)).body).variants.total, 3);
  assert.ok(await get('productVariants', 'manual'));
  const firstVariant = before.variants.items[0];
  assert.ok(firstVariant);
  assert.equal((await get('productVariants', firstVariant.id))?.archived, undefined);
  await approveLocalDetail(product.productId);
  assert.equal(detail((await read(product.productId)).body).variants.total, 0);
  const stale = await materialize(observation());
  assert.equal(stale.stale, true);
});

test('unknown IDs, archived products and malformed approval fail closed', async (t) => {
  await workspace(t);
  assert.equal((await read('unknown')).statusCode, 404);
  const product = await materialize(observation('alibaba', 0));
  await approveLocalDetail(product.productId);
  assert.equal(detail((await read(product.productId)).body).variants.total, 0);
  await updateDoc('products', product.productId, { archived: true });
  assert.equal((await read(product.productId)).statusCode, 404);
  await updateDoc('products', product.productId, {
    archived: false,
    catalogDetailPublication: { state: 'approved', raw: 'secret' },
  });
  assert.equal((await read(product.productId)).statusCode, 404);
});

test('actual local image bytes stay private while draft and use the existing public media gate after approval', async (t) => {
  await workspace(t);
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=',
    'base64',
  );
  const media = await migrateImageLocally(
    {
      ok: true,
      bytes,
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      finalUrl: 'https://example.com/a.png',
      dimensions: { width: 1, height: 1 },
    },
    'Synthetic test pixel',
    new Map(),
  );
  const source = observation();
  source.content.media = [{ sourceUrl: 'https://example.com/a.png', role: 'primary', position: 0 }];
  const product = await materializeLocalDetail({
    observation: source,
    productFamily: 'headphones',
    images: new Map([['https://example.com/a.png', media.imageId]]),
  });
  assert.equal((await getCatalogImage(media.imageId)).ok, false);
  await approveLocalDetail(product.productId);
  const image = await getCatalogImage(media.imageId);
  assert.ok(image.ok && 'body' in image);
  assert.deepEqual(Buffer.from(image.body, 'base64'), bytes);
  assert.deepEqual(detail((await read(product.productId)).body).images, [
    `/api/images/${media.imageId}`,
  ]);
});

test('the real Excel adapter feeds canonical storage and the same public detail handler', async (t) => {
  await workspace(t);
  const parsed = parseDianxiaomiWorkbook(buildAcceptanceWorkbook());
  // Use the adapter's existing grouped-candidate projection, not a single
  // partial store observation masquerading as a complete canonical product.
  const source = dianxiaomiObservationAdapter.toObservations({
    bundle: parsed.bundle,
    observedAt: '2026-09-06T00:00:00.000Z',
  }).observations[0];
  assert.ok(source);
  // Generated workbook acceptance fixture. Media explicitly replaced with a
  // synthetic pixel so this test makes no external supplier-network calls.
  source.content.media = [
    { sourceUrl: 'https://example.com/pixel.png', role: 'primary', position: 0 },
  ];
  for (const variant of source.variants) variant.media = [];
  const product = await materialize(source);
  await approveLocalDetail(product.productId);
  const response = await read(product.productId);
  assert.equal(response.statusCode, 200);
  assert.equal(detail(response.body).variants.total, source.variants.length);
});

test('CUI-01 browser gateway consumes both providers through real HTTP and preserves revision paging', async (t) => {
  await workspace(t);
  const excel = dianxiaomiObservationAdapter.toObservations({
    bundle: parseDianxiaomiWorkbook(buildAcceptanceWorkbook()).bundle,
    observedAt: '2026-09-06T00:00:00.000Z',
  }).observations[0];
  assert.ok(excel);
  excel.content.media = [
    { sourceUrl: 'https://example.com/pixel.png', role: 'primary', position: 0 },
  ];
  for (const variant of excel.variants) variant.media = [];
  const app = express();
  registerCatalogRoutes(app, 'products', '/api/products', { enableCatalogDetail: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  // Keep browser/Astro types out of the Node-only server compilation. The consumer
  // runs in a separate test process and crosses the real HTTP boundary.
  const probe = async (productId: string, expected: string) => {
    await promisify(execFile)(process.execPath, [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(
        new URL('../../site/src/catalog/testing/detail-http-probe.ts', import.meta.url),
      ),
      `http://127.0.0.1:${address.port}`,
      productId,
      expected,
    ]);
  };

  for (const source of [observation('alibaba', 51), excel]) {
    const product = await materialize(source);
    await probe(product.productId, 'not-found');
    await approveLocalDetail(product.productId);
    await probe(product.productId, String(source.variants.length));
  }
});

test('missing media may be repaired on replay without bypassing publication requirements', async (t) => {
  await workspace(t);
  const source = observation();
  const first = await materializeLocalDetail({
    observation: source,
    productFamily: 'headphones',
    images: new Map(),
  });
  await assert.rejects(approveLocalDetail(first.productId), /invalid-product/);
  const repaired = await materialize(source);
  assert.equal(repaired.productId, first.productId);
  await approveLocalDetail(first.productId);
  assert.equal(detail((await read(first.productId)).body).images.length, 1);
});

test('replay cannot replace a published product title or gallery with unapproved source data', async (t) => {
  await workspace(t);
  const source = observation();
  const product = await materialize(source);
  await approveLocalDetail(product.productId);
  const before = await get('products', product.productId);
  source.identity.title = 'Changed source title';
  source.content.media = [];
  source.source.observedAt = '2026-09-06T01:00:00.000Z';
  await materialize(source);
  const after = await get('products', product.productId);
  assert.equal(after?.name, before?.name);
  assert.deepEqual(after?.imageIds, before?.imageIds);
  assert.deepEqual(after?.catalogDetailPublication, before?.catalogDetailPublication);
});

test('partial input does not mark removals; a failed materialization cannot be approved', async (t) => {
  await workspace(t);
  const source = observation();
  const product = await materialize(source);
  source.source.completeness = 'partial-product';
  source.variants = [];
  await assert.rejects(materialize(source), /Complete product required/);
  await updateDoc('products', product.productId, { detailSourceReady: false });
  await assert.rejects(approveLocalDetail(product.productId), /incomplete/);
  assert.equal((await read(product.productId)).statusCode, 404);
});

test('corrupt canonical variant identity and unpublish during a read fail closed', async (t) => {
  const local = await workspace(t);
  const product = await materialize(observation());
  await approveLocalDetail(product.productId);
  const before = detail((await read(product.productId)).body);
  const variant = before.variants.items[0];
  assert.ok(variant);
  await updateDoc('productVariants', variant.id, {
    catalogDetailApproved: { ...variant, id: 'wrong-id' },
  });
  assert.equal((await read(product.productId)).statusCode, 409);
  await updateDoc('productVariants', variant.id, {
    catalogDetailApproved: variant,
    archived: 'false',
  });
  assert.equal((await read(product.productId)).statusCode, 409);
  await updateDoc('productVariants', variant.id, { archived: false });
  const originalGet = local.adapter.get.bind(local.adapter);
  let productReads = 0;
  local.adapter.get = async (collection, id) => {
    const doc = await originalGet(collection, id);
    if (collection === 'products' && ++productReads === 2 && doc)
      return { ...doc, published: false };
    return doc;
  };
  assert.equal((await read(product.productId)).statusCode, 409);
});
