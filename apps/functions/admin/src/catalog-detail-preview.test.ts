import assert from 'node:assert/strict';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { validateCatalogSourceObservation } from '@vibelingan-channel/catalog-import/observations';
import { readCatalogDetailPreview } from './catalog-detail-preview.ts';
import { handleAdminRequest } from './handler.ts';
import { fixture } from './testing/catalog-source-plan-fixture.ts';

for (const count of [0, 1, 20, 21, 105]) {
  test(`readonly preview of ${count} configurations needs no prepared manifest or write`, async () => {
    const { product, adapter } = fixture(count);
    const before = structuredClone(adapter.rows);
    const first = await readCatalogDetailPreview('admin', {
      action: 'preview',
      productId: product._id,
    });
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.kind, 'preview');
    assert.equal(first.detail.name, 'Website title');
    assert.equal(first.detail.variants.total, count);
    assert.equal(first.detail.variants.items.length, Math.min(50, count));
    assert.equal('expectedDigest' in first, false, 'preview is not an approval credential');
    const items = [...first.detail.variants.items];
    for (let page = 2; page <= Math.ceil(count / 50); page++) {
      const next = await readCatalogDetailPreview('admin', {
        action: 'preview',
        productId: product._id,
        page,
        inputDigest: first.inputDigest,
      });
      assert.ok(next.ok, JSON.stringify(next));
      assert.equal(next.inputDigest, first.inputDigest, 'digest is independent of requested page');
      items.push(...next.detail.variants.items);
    }
    assert.equal(items.length, count);
    assert.equal(new Set(items.map((item) => item.id)).size, count);
    assert.deepEqual(adapter.commands, []);
    assert.deepEqual(adapter.rows, before);
  });
}

test('a saved website edit invalidates preview pages and a fresh first page recovers', async () => {
  const { product, adapter } = fixture(105);
  const input = { action: 'preview', productId: product._id };
  const first = await readCatalogDetailPreview('admin', input);
  assert.ok(first.ok);
  product.name = 'Edited website title';
  const before = structuredClone(adapter.rows);
  assert.deepEqual(
    await readCatalogDetailPreview('admin', { ...input, page: 2, inputDigest: first.inputDigest }),
    { ok: false, code: 'CONFLICT' },
  );
  const fresh = await readCatalogDetailPreview('admin', input);
  assert.ok(fresh.ok);
  assert.equal(fresh.detail.name, product.name);
  assert.notEqual(fresh.inputDigest, first.inputDigest);
  assert.deepEqual(adapter.rows, before);
  assert.deepEqual(adapter.commands, []);
});

test('missing, contributor and suspended actors cannot read private preview inputs', async () => {
  for (const actor of [
    null,
    { _id: 'admin', role: 'contributor' },
    { _id: 'admin', role: 'admin', status: 'suspended' },
  ]) {
    const { product, adapter } = fixture(1);
    adapter.rows.users = actor ? [actor] : [];
    const reads: string[] = [];
    const get = adapter.get.bind(adapter);
    adapter.get = async (collection, id) => {
      reads.push(collection);
      return get(collection, id);
    };
    assert.deepEqual(
      await readCatalogDetailPreview('admin', { action: 'preview', productId: product._id }),
      { ok: false, code: 'FORBIDDEN' },
    );
    assert.deepEqual(reads, ['users']);
    assert.deepEqual(adapter.commands, []);
  }
});

test('preview refuses invalid requests and never treats browser snapshots as trusted data', async () => {
  const { product, adapter } = fixture(1);
  for (const input of [
    { action: 'preview', productId: product._id, page: 0 },
    { action: 'preview', productId: product._id, page: 201 },
    { action: 'preview', productId: product._id, detail: { name: 'Injected' } },
    { action: 'preview', productId: product._id, inputDigest: 'wrong' },
  ]) {
    const result = await readCatalogDetailPreview('admin', input);
    assert.ok(!result.ok && result.code === 'VALIDATION_ERROR', JSON.stringify(result));
  }
  assert.deepEqual(adapter.commands, []);
});

test('source or primary link replacement invalidates an earlier preview page', async () => {
  for (const change of ['source', 'link']) {
    const { product, adapter } = fixture(105);
    const input = { action: 'preview', productId: product._id };
    const first = await readCatalogDetailPreview('admin', input);
    assert.ok(first.ok);
    if (change === 'source') {
      const source = adapter.rows.alibabaSourceProducts?.[0];
      assert.ok(source);
      source.sourceUpdatedAt = '2026-10-14T00:02:00.000Z';
    } else {
      const link = adapter.rows.alibabaProductLinks?.[0];
      assert.ok(link);
      link.linkedAt = '2026-10-14T00:02:00.000Z';
    }
    const next = await readCatalogDetailPreview('admin', {
      ...input,
      page: 2,
      inputDigest: first.inputDigest,
    });
    assert.ok(!next.ok, 'do not combine configurations from different source identities');
    assert.deepEqual(adapter.commands, []);
  }
});

test('edits or suspension during the source read never return a mixed or unauthorized result', async () => {
  for (const change of ['edit', 'suspend']) {
    const { product, adapter } = fixture(1);
    const get = adapter.get.bind(adapter);
    adapter.get = async (collection, id) => {
      const row = await get(collection, id);
      if (collection === 'alibabaProductLinks') {
        if (change === 'edit') product.name = 'Changed while reading';
        else adapter.rows.users = [{ _id: 'admin', role: 'admin', status: 'suspended' }];
      }
      return row;
    };
    assert.deepEqual(
      await readCatalogDetailPreview('admin', { action: 'preview', productId: product._id }),
      { ok: false, code: change === 'edit' ? 'CONFLICT' : 'FORBIDDEN' },
    );
    assert.deepEqual(adapter.commands, []);
  }
});

test('source replacement during reading refuses the mixed preview before returning any detail', async () => {
  const { product, adapter } = fixture(1);
  const get = adapter.get.bind(adapter);
  let calls = 0;
  adapter.get = async (collection, id) => {
    const row = await get(collection, id);
    if (collection === 'alibabaProductLinks' && ++calls === 1) {
      const source = adapter.rows.alibabaSourceProducts?.[0];
      assert.ok(source);
      source.sourceUpdatedAt = '2026-10-14T00:03:00.000Z';
    }
    return row;
  };
  assert.deepEqual(
    await readCatalogDetailPreview('admin', { action: 'preview', productId: product._id }),
    { ok: false, code: 'CONFLICT' },
  );
  assert.deepEqual(adapter.commands, []);
});

test('archived source drafts remain readable without restore, prepare or publish', async () => {
  const { product, adapter } = fixture(21);
  product.archived = true;
  const before = structuredClone(adapter.rows);
  const preview = await readCatalogDetailPreview('admin', {
    action: 'preview',
    productId: product._id,
  });
  assert.ok(preview.ok, JSON.stringify(preview));
  assert.equal(preview.detail.variants.total, 21);
  assert.deepEqual(adapter.rows, before);
  assert.deepEqual(adapter.commands, []);
});

test('manual zero-configuration drafts remain readonly and old Alibaba rows cannot become manual configurations', async () => {
  for (const configurations of ['empty', 'alibaba', 'manual']) {
    const { product, adapter } = fixture(0);
    product.alibabaPrimarySourceKey = '';
    const rows =
      configurations === 'empty'
        ? []
        : [
            {
              _id: 'variant',
              productId: product._id,
              ...(configurations === 'alibaba' ? { detailSourceOwner: 'alibaba:old-source' } : {}),
            },
          ];
    adapter.list = async () => ({ items: rows, total: rows.length, page: 1, pageSize: 100 });
    const before = structuredClone(adapter.rows);
    const preview = await readCatalogDetailPreview('admin', {
      action: 'preview',
      productId: product._id,
    });
    if (configurations === 'manual')
      assert.deepEqual(preview, { ok: false, code: 'MANUAL_CONFIGURATIONS' });
    else {
      assert.ok(preview.ok, JSON.stringify(preview));
      assert.equal(preview.detail.variants.total, 0);
      assert.equal(preview.detail.name, product.name);
    }
    assert.deepEqual(adapter.commands, []);
    assert.deepEqual(adapter.rows, before);
  }
});

test('the real HTTP handler routes readonly preview and returns safe late-configuration issues', async () => {
  const { product, adapter } = fixture(105);
  const config = { jwtSecret: 'test-preview-secret', enableDetailApproval: true };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const request = {
    action: 'catalogDetailApproval',
    token,
    data: { action: 'preview', productId: product._id },
  };
  const before = structuredClone(adapter.rows);
  const result = await handleAdminRequest(request, config);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(Reflect.get(result.data ?? {}, 'kind'), 'preview');
  assert.deepEqual(adapter.rows, before);
  const row = adapter.rows.catalogSourceObservations?.[0];
  assert.ok(row);
  const valid = validateCatalogSourceObservation(row.observation);
  assert.ok(valid.ok);
  const last = valid.value.variants[104];
  assert.ok(last);
  last.sku = 'private-source-value'.repeat(12);
  row.observation = valid.value;
  const failed = await handleAdminRequest(request, config);
  assert.ok(!failed.ok);
  assert.equal(failed.error.code, 'VALIDATION_ERROR');
  assert.match(failed.error.message, /Configuration 105/);
  assert.doesNotMatch(JSON.stringify(failed), /private-source-value/);
  assert.deepEqual(adapter.commands, []);
});

test('source image fallbacks use the bound current observation, without importing or using stale row URLs', async () => {
  const { product, adapter } = fixture(0);
  product.alibabaSourceImageUrls = ['https://s.alicdn.com/stale-row.png'];
  product.alibabaDescriptionImageUrls = ['https://s.alicdn.com/stale-description.png'];
  const row = adapter.rows.catalogSourceObservations?.[0];
  assert.ok(row);
  const valid = validateCatalogSourceObservation(row.observation);
  assert.ok(valid.ok);
  valid.value.content.media = Array.from({ length: 12 }, (_, index) => ({
    sourceUrl: `https://s.alicdn.com/current-${index}.png`,
    position: index,
    role: 'gallery',
  }));
  assert.ok(valid.value.content.description);
  valid.value.content.description.imageUrls = Array.from(
    { length: 20 },
    (_, index) => `https://s.alicdn.com/description-${index}.png`,
  );
  row.observation = valid.value;
  const before = structuredClone(adapter.rows);
  const preview = await readCatalogDetailPreview('admin', {
    action: 'preview',
    productId: product._id,
  });
  assert.ok(preview.ok, JSON.stringify(preview));
  assert.deepEqual(preview.previewMedia.galleryIds, []);
  assert.deepEqual(
    preview.previewMedia.gallerySources,
    valid.value.content.media.slice(0, 9).map((media) => media.sourceUrl),
  );
  assert.deepEqual(
    preview.previewMedia.descriptionSources,
    valid.value.content.description.imageUrls.slice(0, 18),
  );
  assert.deepEqual(adapter.rows, before);
  assert.deepEqual(adapter.commands, []);
});

test('manual preview must not report zero configurations when the server query exceeds its supported scan', async () => {
  const { product, adapter } = fixture(0);
  product.alibabaPrimarySourceKey = '';
  adapter.list = async () => ({
    items: [{ _id: 'old', detailSourceOwner: 'alibaba:old' }],
    total: 10001,
    page: 1,
    pageSize: 100,
  });
  const preview = await readCatalogDetailPreview('admin', {
    action: 'preview',
    productId: product._id,
  });
  assert.ok(!preview.ok && preview.code === 'VALIDATION_ERROR', JSON.stringify(preview));
  assert.deepEqual(adapter.commands, []);
});
