import { strict as assert } from 'node:assert';
import test from 'node:test';
import type {
  AdapterListQuery,
  CatalogProductSaveInput,
  CatalogProductSaveResult,
  DbAdapter,
} from '@vibelingan-channel/db';
import { setAdapter } from '@vibelingan-channel/db';
import type { CollectionDoc, ListResult } from '@vibelingan-channel/shared';
import {
  CatalogProductWriteError,
  createCatalogProductRecord,
  updateCatalogProductRecord,
} from './catalog-product-identities.ts';

class SaveSpyAdapter implements DbAdapter {
  inputs: CatalogProductSaveInput[] = [];
  result: CatalogProductSaveResult = {
    result: 'saved',
    doc: { _id: 'product-1', slug: 'desk-lamp', skuCode: 'sku-100' },
  };

  async list(_query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    throw new Error('not used');
  }
  async get(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async findByField(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async create(): Promise<CollectionDoc> {
    throw new Error('not used');
  }
  async update(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async remove(): Promise<boolean> {
    throw new Error('not used');
  }
  async incrementField(): Promise<number | null> {
    throw new Error('not used');
  }
  async saveCatalogProductWithIdentities(
    input: CatalogProductSaveInput,
  ): Promise<CatalogProductSaveResult> {
    this.inputs.push(input);
    return this.result;
  }
}

function setup(): SaveSpyAdapter {
  const adapter = new SaveSpyAdapter();
  setAdapter(adapter);
  return adapter;
}

test('create uses one stable product id and canonical identity values', async () => {
  const adapter = setup();
  const doc = await createCatalogProductRecord(
    { name: 'Desk Lamp', slug: ' Desk Lamp ', skuCode: ' SKU-100 ' },
    'product-stable',
  );
  assert.equal(doc._id, 'product-1');
  assert.deepEqual(adapter.inputs, [
    {
      mode: 'create',
      productId: 'product-stable',
      data: { name: 'Desk Lamp', slug: 'desk-lamp', skuCode: 'sku-100' },
    },
  ]);
});

test('create generates one UUID when the caller does not supply a product id', async () => {
  const adapter = setup();
  await createCatalogProductRecord({ name: 'Draft' });
  assert.match(
    adapter.inputs[0]?.productId ?? '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('draft create preserves absent identity fields', async () => {
  const adapter = setup();
  await createCatalogProductRecord({ name: 'Draft' }, 'draft-1');
  assert.deepEqual(adapter.inputs[0], {
    mode: 'create',
    productId: 'draft-1',
    data: { name: 'Draft' },
  });
});

test('partial update canonicalizes only identity fields present in the patch', async () => {
  const adapter = setup();
  await updateCatalogProductRecord('product-1', { description: 'Updated', skuCode: ' New-200 ' });
  assert.deepEqual(adapter.inputs[0], {
    mode: 'update',
    productId: 'product-1',
    data: { description: 'Updated', skuCode: 'new-200' },
  });
});

test('whitespace-only identity fields canonicalize to empty draft values', async () => {
  const adapter = setup();
  await updateCatalogProductRecord('product-1', { slug: '   ', skuCode: '\t' });
  assert.deepEqual(adapter.inputs[0]?.data, { slug: '', skuCode: '' });
});

test('invalid identity fails before the storage adapter is called', async () => {
  const adapter = setup();
  await assert.rejects(
    createCatalogProductRecord({ slug: 'products', skuCode: 'SKU-100' }, 'product-1'),
    (error: unknown) =>
      error instanceof CatalogProductWriteError && error.code === 'INVALID_IDENTITY',
  );
  assert.equal(adapter.inputs.length, 0);
});

test('malformed values containers fail before the storage adapter is called', async () => {
  for (const values of [null, [], 'invalid']) {
    const adapter = setup();
    await assert.rejects(
      updateCatalogProductRecord('product-1', values),
      (error: unknown) =>
        error instanceof CatalogProductWriteError && error.code === 'INVALID_IDENTITY',
    );
    assert.equal(adapter.inputs.length, 0);
  }
});

test('storage outcomes map to stable domain errors', async () => {
  const cases: Array<{
    result: CatalogProductSaveResult;
    code: CatalogProductWriteError['code'];
  }> = [
    {
      result: { result: 'conflict', kind: 'slug', normalizedValue: 'taken' },
      code: 'IDENTITY_CONFLICT',
    },
    { result: { result: 'invalid', kind: 'sku' }, code: 'INVALID_IDENTITY' },
    { result: { result: 'exists' }, code: 'PRODUCT_EXISTS' },
    { result: { result: 'missing' }, code: 'PRODUCT_NOT_FOUND' },
  ];
  for (const entry of cases) {
    const adapter = setup();
    adapter.result = entry.result;
    await assert.rejects(
      updateCatalogProductRecord('product-1', { slug: 'valid', skuCode: 'valid' }),
      (error: unknown) => error instanceof CatalogProductWriteError && error.code === entry.code,
    );
  }
});
