import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import {
  createAlibabaPricingAdapter,
  resolveCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import { z } from 'zod';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { getProductDetail } from '../../functions/public-api/src/catalog-detail.ts';
import { publicDoc } from '../../functions/public-api/src/handler.ts';
import { JsonFileAdapter } from './json-adapter.ts';

test('manual price patches cannot leave published list and approved detail on different prices', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-manual-price-publication-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const product = {
    _id: 'headset',
    name: 'Headset',
    description: 'Description is independent of price.',
    productFamily: 'headphones',
    category: 'wired',
    imageIds: ['image'],
    published: false,
    archived: false,
    unitPrice: 3,
    catalogPricingMode: 'manual',
    alibabaPrimarySourceKey: 'source',
    detailSourceReady: true,
    detailSourceOwner: 'source',
    detailSourceRevision: 'source-r1',
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    detailSourceCandidate: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'headset',
      name: 'Source headset',
      images: ['/api/images/image'],
      facts: [],
      offers: [
        {
          kind: 'supplier',
          basis: 'source-quote',
          pricing: { mode: 'fixed', currency: 'USD', amountMinor: 290 },
        },
      ],
    },
  };
  writeFileSync(
    file,
    JSON.stringify({
      products: [product],
      users: [{ _id: 'admin', role: 'admin', status: 'active' }],
      images: [
        {
          _id: 'image',
          status: 'active',
          storageProvider: 'local-disk',
          refCount: 1,
          publishedRefCount: 0,
        },
      ],
    }),
  );
  let adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const config = { jwtSecret: 'manual-price-local-test-only', enableDetailApproval: true };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Test Admin',
    email: 'admin@example.test',
  });
  const save = (values: Record<string, unknown>) =>
    handleAdminRequest(
      {
        action: 'update',
        token,
        data: { collection: 'products', id: 'headset', values },
      },
      config,
    );
  const approve = async () => {
    const call = (data: unknown) =>
      handleAdminRequest({ action: 'catalogDetailApproval', token, data }, config);
    const review = await call({ action: 'review', productId: 'headset' });
    assert.ok(review.ok, JSON.stringify(review));
    const reviewed = z
      .object({ expectedDigest: z.string(), expectedRevision: z.string().nullable() })
      .parse(review.data);
    const begin = await call({
      action: 'begin',
      command: { productId: 'headset', operationId: randomUUID(), ...reviewed },
    });
    assert.ok(begin.ok, JSON.stringify(begin));
    const job = z.object({ jobId: z.string(), pages: z.number() }).parse(begin.data);
    for (let page = 0; page < job.pages; page++) {
      const result = await call({ action: 'page', jobId: job.jobId, page });
      assert.ok(result.ok, JSON.stringify(result));
    }
    const finish = await call({ action: 'finish', jobId: job.jobId });
    assert.ok(finish.ok, JSON.stringify(finish));
  };
  const assertPublicPrice = async (amount: number) => {
    // Reload durable state; no editor cache or in-memory draft is the evidence.
    adapter = new JsonFileAdapter(file);
    setAdapter(adapter);
    const saved = await adapter.get('products', 'headset');
    assert.ok(saved);
    const projected = publicDoc('products', saved, {});
    assert.deepEqual(
      resolveCatalogPricing(
        { ...projected, unitPrice: projected.unitPrice },
        createAlibabaPricingAdapter(),
      ),
      {
        source: 'scalar',
        field: 'unitPrice',
        currency: 'USD',
        amount,
      },
    );
    const detail = await getProductDetail('headset');
    assert.ok(detail.ok, JSON.stringify(detail));
    assert.deepEqual(detail.data.websitePricing, {
      basis: 'website-manual',
      pricing: { mode: 'fixed', currency: 'USD', amountMinor: amount * 100 },
    });
    assert.equal(detail.data.descriptionText, product.description);
  };

  await approve();
  assert.ok((await save({ published: true })).ok);
  await assertPublicPrice(3);
  await t.test(
    'non-price form saves preserve publication and approved detail until review',
    async () => {
      const approved = await adapter.get('products', 'headset');
      const result = await save({
        productFamily: 'misc',
        category: '',
        unitPrice: 3,
        catalogPricingMode: 'manual',
      });
      assert.ok(result.ok, JSON.stringify(result));
      const saved = await adapter.get('products', 'headset');
      assert.equal(saved?.published, true);
      assert.equal(saved?.productFamily, 'misc');
      assert.deepEqual(saved?.catalogDetailPublication, approved?.catalogDetailPublication);
      assert.deepEqual(saved?.catalogDetailApprovalReceipt, approved?.catalogDetailApprovalReceipt);
      assert.equal((await save({ published: true })).ok, false);
      assert.deepEqual(await adapter.get('products', 'headset'), saved);
      await assertPublicPrice(3);
      await approve();
      assert.ok((await save({ productFamily: 'headphones', category: 'wired' })).ok);
      await approve();
    },
  );
  const before = await adapter.get('products', 'headset');
  for (const values of [
    { unitPrice: 8.5 },
    { wholesalePrice: 8.5 },
    { catalogPricingMode: 'source' },
    { moq: 10 },
    { manualCatalogPricing: null },
    { productFamily: 'misc', category: '', unitPrice: 8.5 },
    {
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: [{ minQuantity: 5, unitAmountMinor: 850 }],
      },
    },
    { unitPrice: 8.5, published: true },
  ]) {
    const result = await save(values);
    assert.equal(
      result.ok,
      false,
      `unreviewed published patch accepted: ${JSON.stringify(values)}`,
    );
    if (!result.ok) assert.equal(result.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(await adapter.get('products', 'headset'), before);
    await assertPublicPrice(3);
  }
  assert.ok((await save({ unitPrice: 3 })).ok, 'unchanged pricing remains editable');

  assert.ok((await save({ published: false, unitPrice: 8.5 })).ok);
  const draft = await adapter.get('products', 'headset');
  assert.equal(draft?.unitPrice, 8.5, 'manual save persists independently of source sync');
  assert.deepEqual(draft?.catalogDetailPublication, before?.catalogDetailPublication);
  assert.equal((await getProductDetail('headset')).ok, false);
  assert.equal(
    (await save({ published: true })).ok,
    false,
    'old approval cannot publish changed pricing',
  );
  await approve();
  assert.ok((await save({ published: true })).ok);
  await assertPublicPrice(8.5);
});
