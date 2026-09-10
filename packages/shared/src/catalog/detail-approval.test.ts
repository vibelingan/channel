import assert from 'node:assert/strict';
import test from 'node:test';
import { planCatalogDetailApproval } from './detail-approval.ts';

function fixture() {
  const variant = (id: string, position: number) => ({
    _id: id,
    productId: 'product',
    detailSourceOwner: 'source-owner',
    detailSourceMissing: false,
    position,
    sku: 'MANUAL-SKU',
    optionValues: { Color: 'Blue' },
    imageIds: ['image'],
    detailSourceCandidate: {
      id,
      sku: 'SOURCE-SKU',
      options: [{ name: 'Color', value: 'Red' }],
      images: ['/api/images/image'],
      inventory: { state: 'unknown' },
      offers: [],
    },
  });
  return {
    product: {
      _id: 'product',
      name: 'Reviewed title',
      description: 'Source text',
      imageIds: ['image'],
      archived: false,
      detailSourceReady: true,
      detailSourceOwner: 'source-owner',
      detailSourceCandidate: {
        _id: 'product',
        name: 'Source title',
        schemaVersion: 'catalog-product-detail-v1',
        descriptionText: 'Source text',
        images: ['/api/images/image'],
        facts: [],
        offers: [],
      },
      detailSourceContentCandidate: {
        schemaVersion: 'catalog-content-v1',
        specifications: [],
        packaging: [],
        notes: ['Source heading'],
      },
      detailSourceNoteBlocksCandidate: [{ kind: 'heading', text: 'Source heading' }],
      privateEvidence: 'must not escape',
    },
    variants: [variant('b', 1), variant('a', 1), variant('c', 0)],
    revision: 'revision',
  };
}

test('an untouched synchronized draft can be reviewed before importing its gallery', () => {
  const input = fixture();
  const { imageIds: _images, ...product } = input.product;
  const variants = input.variants.map((v) => ({
    ...v,
    imageIds: [],
    detailSourceCandidate: { ...v.detailSourceCandidate, images: [] },
  }));
  const result = planCatalogDetailApproval({ ...input, product, variants });
  assert.deepEqual(result.publication.header.images, []);
  assert.equal(result.variants.length, 3);
  for (const imageIds of [null, '', {}, [null]]) {
    assert.throws(() =>
      planCatalogDetailApproval({ ...input, product: { ...product, imageIds }, variants }),
    );
  }
});

test('approved website override is distinct from unchanged supplier offers; source mode removes only override', () => {
  const input = fixture();
  const manual = { ...input.product, catalogPricingMode: 'manual', unitPrice: 3.1, moq: 1000 };
  const result = planCatalogDetailApproval({ ...input, product: manual });
  assert.deepEqual(Reflect.get(result.publication.header, 'websitePricing'), {
    basis: 'website-manual',
    pricing: { mode: 'fixed', currency: 'USD', amountMinor: 310, minimumOrderQuantity: 1000 },
  });
  assert.deepEqual(result.publication.header.offers, []);
  const followed = planCatalogDetailApproval({
    ...input,
    product: { ...manual, catalogPricingMode: 'source' },
  });
  assert.equal(Reflect.get(followed.publication.header, 'websitePricing'), undefined);
});

test('approval uses the current website family, not a stale prepared or supplier category label', () => {
  const input = fixture();
  const product = {
    ...input.product,
    productFamily: 'toys',
    detailSourceCandidate: { ...input.product.detailSourceCandidate, categoryLabel: 'wired' },
  };
  assert.equal(
    planCatalogDetailApproval({ ...input, product }).publication.header.categoryLabel,
    'Toys',
  );
});

test('approval preserves reviewed fields, orders canonical rows and never mutates input or projects private data', () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = planCatalogDetailApproval(input);
  assert.deepEqual(input, before);
  assert.deepEqual(
    result.variants.map((v) => v.id),
    ['c', 'a', 'b'],
  );
  assert.equal(result.publication.header.name, 'Reviewed title');
  assert.equal(result.publication.variantCount, 3);
  assert.equal(result.variants[0]?.sku, 'MANUAL-SKU');
  assert.deepEqual(result.variants[0]?.options, [{ name: 'Color', value: 'Blue' }]);
  assert.deepEqual(result.publication.noteBlocks, input.product.detailSourceNoteBlocksCandidate);
  assert.equal(JSON.stringify(result).includes('must not escape'), false);
  assert.equal(JSON.stringify(result).includes('source-owner'), false);
});

test('unknown and malformed inputs cannot become empty successful approvals', () => {
  for (const invalid of [undefined, null, '', [], 0, {}, 'null']) {
    assert.throws(() => planCatalogDetailApproval({ ...fixture(), product: invalid }));
  }
  for (const invalid of [undefined, null, '', 0, {}, 'null']) {
    assert.throws(() => planCatalogDetailApproval({ ...fixture(), variants: invalid }));
  }
  for (const revision of ['', ' revision ', 'x'.repeat(201)])
    assert.throws(() => planCatalogDetailApproval({ ...fixture(), revision }));
});

test('explicit complete empty variant sets remain valid for product-level inquiries', () => {
  const result = planCatalogDetailApproval({ ...fixture(), variants: [] });
  assert.equal(result.publication.variantCount, 0);
  assert.deepEqual(result.variants, []);
});

test('product lifecycle and candidate identity must match without coercion', () => {
  for (const patch of [
    { detailSourceReady: false },
    { archived: true },
    { archived: null },
    { _id: 'another-product' },
    { _id: ' product ' },
    { imageIds: [null] },
    { imageIds: ['https://supplier/image'] },
  ]) {
    const input = fixture();
    assert.throws(() =>
      planCatalogDetailApproval({ ...input, product: { ...input.product, ...patch } }),
    );
  }
});

test('cross-product, wrong owner, forged, duplicate and invalid active variants are rejected', () => {
  const base = fixture().variants[0];
  assert.ok(base);
  for (const patch of [
    { productId: 'another-product' },
    { detailSourceOwner: 'another-owner' },
    { _id: 'forged' },
    { detailSourceMissing: true },
    { archived: true },
    { archived: null },
    { position: '1' },
    { position: -1 },
    { position: Number.NaN },
    { optionValues: null },
    { optionValues: { Color: 2 } },
  ])
    assert.throws(() =>
      planCatalogDetailApproval({ ...fixture(), variants: [{ ...base, ...patch }] }),
    );
  assert.throws(() => planCatalogDetailApproval({ ...fixture(), variants: [base, base] }));
});

test('variant-only images are rejected before any persistence can begin', () => {
  const input = fixture();
  const row = input.variants[0];
  assert.ok(row);
  row.imageIds = ['private-image'];
  assert.throws(() => planCatalogDetailApproval(input), /gallery/);
});

test('unchanged descriptions require matching approved notes and reject orphan note blocks', () => {
  const input = fixture();
  input.product.detailSourceNoteBlocksCandidate[0] = { kind: 'heading', text: 'Wrong text' };
  assert.throws(() => planCatalogDetailApproval(input));
  const original = fixture();
  assert.throws(() =>
    planCatalogDetailApproval({
      ...original,
      product: { ...original.product, detailSourceContentCandidate: null },
    }),
  );
});

test('operator description replacement or deletion invalidates supplier-derived content', () => {
  for (const description of ['Reviewed new description', '']) {
    const input = fixture();
    const result = planCatalogDetailApproval({
      ...input,
      product: {
        ...input.product,
        description,
        detailSourceContentCandidate: 'stale corrupt data',
      },
    });
    assert.equal(result.publication.header.descriptionText, description || undefined);
    assert.equal(Object.hasOwn(result.publication, 'content'), false);
    assert.equal(Object.hasOwn(result.publication, 'noteBlocks'), false);
  }
});
