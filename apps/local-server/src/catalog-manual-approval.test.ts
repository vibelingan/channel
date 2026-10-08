/**
 * A manual product, end to end through the real handlers on a local database
 * (MIU-34): approve and publish like a synced product, then the list, the
 * product page and a customization quote all read the one approved version,
 * and the list item looks exactly like a synced product's.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import { z } from 'zod';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { getProductDetail } from '../../functions/public-api/src/catalog-detail.ts';
import { listCatalog } from '../../functions/public-api/src/handler.ts';
import { JsonFileAdapter } from './json-adapter.ts';

// Optional fields both products carry (each also has its own SKU), so their
// list items can be compared key for key.
const shared = {
  description: 'Soft ear pads and a padded band.',
  productFamily: 'headphones',
  category: 'wired',
  published: false,
  archived: false,
  series: 'S1',
  modName: 'M1',
  modType: 'Over-ear',
};
const image = (id: string) => ({
  _id: id,
  status: 'active',
  storageProvider: 'local-disk',
  refCount: 1,
  publishedRefCount: 0,
});

test('a manual product is approved, listed, shown and quoted like a synced one', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-manual-approval-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const manual = {
    _id: 'manual-1',
    name: 'Kids headset',
    skuCode: 'KH-01',
    imageIds: ['img-1', 'img-2'],
    catalogPricingMode: 'manual',
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [
        { minQuantity: 50, maxQuantity: 199, unitAmountMinor: 450 },
        { minQuantity: 200, unitAmountMinor: 400 },
      ],
    },
    ...shared,
  };
  // A synced product prepared from its source (staged candidate, no SKUs).
  const synced = {
    _id: 'synced-1',
    name: 'Synced headset',
    skuCode: 'KH-02',
    imageIds: ['img-3'],
    alibabaPrimarySourceKey: 'source-a',
    detailSourceReady: true,
    detailSourceOwner: 'alibaba:source-a',
    detailSourceRevision: 'source-r1',
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    detailSourceCandidate: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'synced-1',
      name: 'Supplier title',
      images: ['/api/images/img-3'],
      facts: [{ name: 'Material', value: 'ABS' }],
      offers: [
        {
          kind: 'supplier',
          basis: 'source-quote',
          pricing: {
            mode: 'tiered',
            currency: 'USD',
            minimumOrderQuantity: 50,
            tiers: [
              { minimumQuantity: 50, maximumQuantity: 199, unitAmountMinor: 450 },
              { minimumQuantity: 200, unitAmountMinor: 400 },
            ],
          },
        },
      ],
    },
    ...shared,
  };
  writeFileSync(
    file,
    JSON.stringify({
      products: [manual, synced],
      users: [{ _id: 'admin', role: 'admin', status: 'active' }],
      images: ['img-1', 'img-2', 'img-3'].map(image),
    }),
  );
  // Public quote requests on, as on the live site.
  const adapter = new JsonFileAdapter(file, true);
  setAdapter(adapter);
  const config = { jwtSecret: 'manual-approval-local-test-only', enableDetailApproval: true };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Test Admin',
    email: 'admin@example.test',
  });
  const admin = (action: string, data: unknown) =>
    handleAdminRequest({ action, token, data }, config);
  const approval = (data: unknown) => admin('catalogDetailApproval', data);

  // The step-by-step protocol the browser falls back to: review → begin →
  // pages → finish → publish (a synced product's source is already prepared).
  const approveAndPublish = async (productId: string) => {
    const review = await approval({ action: 'review', productId });
    assert.ok(review.ok, JSON.stringify(review));
    const reviewed = z
      .object({ expectedDigest: z.string(), expectedRevision: z.string().nullable() })
      .parse(review.data);
    const begin = await approval({
      action: 'begin',
      command: { productId, operationId: randomUUID(), ...reviewed },
    });
    assert.ok(begin.ok, JSON.stringify(begin));
    const job = z.object({ jobId: z.string(), pages: z.number() }).parse(begin.data);
    for (let page = 0; page < job.pages; page++)
      assert.ok((await approval({ action: 'page', jobId: job.jobId, page })).ok);
    const finish = await approval({ action: 'finish', jobId: job.jobId });
    assert.ok(finish.ok, JSON.stringify(finish));
    const published = await admin('update', {
      collection: 'products',
      id: productId,
      values: { published: true },
    });
    assert.ok(published.ok, JSON.stringify(published));
  };
  // The manual product approves in one request (publish speed, 2026-10-08).
  const once = await approval({
    action: 'approve',
    productId: 'manual-1',
    operationId: randomUUID(),
  });
  assert.ok(once.ok, JSON.stringify(once));
  assert.equal(z.object({ status: z.string() }).parse(once.data).status, 'approved');
  const publishedManual = await admin('update', {
    collection: 'products',
    id: 'manual-1',
    values: { published: true },
  });
  assert.ok(publishedManual.ok, JSON.stringify(publishedManual));
  await approveAndPublish('synced-1');

  // As deployed: the approved version is the public one.
  const list = await listCatalog(
    'products',
    { page: 1, pageSize: 24 },
    { enableCatalogDetail: true },
  );
  assert.ok(list.ok, JSON.stringify(list));
  const items = z
    .object({ items: z.array(z.record(z.string(), z.unknown())) })
    .parse(list.data).items;
  const item = (id: string) => {
    const found = items.find((entry) => entry._id === id);
    assert.ok(found, `${id} is listed`);
    return found;
  };
  const manualItem = item('manual-1');
  // Indistinguishable: the same keys as the synced item, nothing supplier-only.
  assert.deepEqual(Object.keys(manualItem).sort(), Object.keys(item('synced-1')).sort());
  assert.equal(
    Object.keys(manualItem).some((key) => key.startsWith('alibaba') || key === 'variants'),
    false,
    Object.keys(manualItem).join(', '),
  );

  // Even if the row's price drifts after approval, the card, the page and the
  // quote read the approved version, never the row.
  await adapter.update('products', 'manual-1', {
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [{ minQuantity: 1, unitAmountMinor: 99 }],
    },
  });
  const relisted = await listCatalog(
    'products',
    { page: 1, pageSize: 24 },
    { enableCatalogDetail: true },
  );
  assert.ok(relisted.ok);
  const card = z
    .object({ items: z.array(z.record(z.string(), z.unknown())) })
    .parse(relisted.data)
    .items.find((entry) => entry._id === 'manual-1');
  assert.deepEqual(card?.priceSummary, {
    source: 'website',
    pricing: {
      mode: 'tiered',
      currency: 'USD',
      minimumOrderQuantity: 50,
      tiers: [
        { minimumQuantity: 50, maximumQuantity: 199, unitAmountMinor: 450 },
        { minimumQuantity: 200, unitAmountMinor: 400 },
      ],
    },
  });
  // The card and the page read the same approved price.
  const detail = await getProductDetail('manual-1');
  assert.ok(detail.ok, JSON.stringify(detail));
  const stored = await adapter.get('products', 'manual-1');
  const publication = z
    .object({ revision: z.string(), priceSummary: z.unknown() })
    .parse(stored?.catalogDetailPublication);
  assert.deepEqual(manualItem.priceSummary, publication.priceSummary);
  assert.deepEqual(detail.data.websitePricing?.pricing, {
    mode: 'tiered',
    currency: 'USD',
    minimumOrderQuantity: 50,
    tiers: [
      { minimumQuantity: 50, maximumQuantity: 199, unitAmountMinor: 450 },
      { minimumQuantity: 200, unitAmountMinor: 400 },
    ],
  });
  assert.deepEqual(manualItem.moq, 50);
  // The spec fields are the page's facts; a manual product has no configurations.
  assert.deepEqual(
    detail.data.facts.map((fact) => fact.name),
    ['SKU', 'Series', 'Model', 'Type'],
  );
  assert.equal(detail.data.variants.total, 0);

  // A customization request records the approved version's snapshot.
  const quote = await adapter.submitCatalogQuote({
    idempotencyKey: randomUUID(),
    target: { intent: 'customization', productId: 'manual-1', revision: publication.revision },
    fields: {
      intent: 'customization',
      quantity: '100',
      deliveryDate: '',
      customizationTypes: ['logo'],
      brief: 'Our logo printed on the headband, please.',
      contactName: 'Test Buyer',
      email: 'buyer@example.test',
      company: 'Test Co',
      country: 'HK',
    },
  });
  assert.ok(quote.ok, JSON.stringify(quote));
  const requests = z
    .array(z.object({ snapshot: z.object({ productName: z.string() }) }))
    .parse(JSON.parse(readFileSync(file, 'utf8')).catalogQuoteRequests);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.snapshot.productName, 'Kids headset');
});
