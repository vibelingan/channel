import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATALOG_DETAIL_VARIANT_MAX_BYTES,
  catalogVariantCapacityIssues,
  planCatalogDetailApproval,
} from './detail-approval.ts';
import { CatalogValidationError } from './issues.ts';
import { CatalogDetailVariantSchema } from './product-detail.ts';

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

test('description bindings are operator-owned, separately bounded and included in approval media checks', () => {
  const input = fixture();
  const product = {
    ...input.product,
    descriptionImageIds: ['detail-a', 'detail-b'],
    detailSourceCandidate: {
      ...input.product.detailSourceCandidate,
      descriptionImages: ['/api/images/forged'],
    },
  };
  const result = planCatalogDetailApproval({ ...input, product });
  assert.deepEqual(result.publication.header.descriptionImages, [
    '/api/images/detail-a',
    '/api/images/detail-b',
  ]);
  assert.deepEqual(result.imageIds, ['image', 'detail-a', 'detail-b']);
  for (const bad of [
    null,
    'detail',
    [null],
    ['../forged'],
    Array.from({ length: 19 }, (_, i) => `id-${i}`),
  ]) {
    assert.throws(() =>
      planCatalogDetailApproval({ ...input, product: { ...product, descriptionImageIds: bad } }),
    );
  }
  const old = planCatalogDetailApproval(input);
  assert.equal(
    old.publication.header.descriptionImages,
    undefined,
    'old records remain approvable',
  );
});

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

test('variant-only images have an independent approval manifest, without changing the product gallery', () => {
  const input = fixture();
  const row = input.variants[0];
  assert.ok(row);
  row.imageIds = ['private-image'];
  const result = planCatalogDetailApproval(input);
  assert.deepEqual(result.publication.header.images, ['/api/images/image']);
  assert.ok(result.publication.variantImageIds?.includes('private-image'));
  assert.ok(result.imageIds.includes('private-image'));
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

test('approval stores the card price summary from the same approved SKUs', () => {
  const input = fixture();
  const priced = (id: string, pricing: object) => {
    const row = input.variants.find((variant) => variant._id === id);
    if (!row) throw new Error('fixture variant missing');
    return {
      ...row,
      detailSourceCandidate: {
        ...row.detailSourceCandidate,
        offers: [{ kind: 'supplier', basis: 'source-quote', pricing }],
      },
    };
  };
  const tiers = {
    mode: 'tiered',
    currency: 'USD',
    minimumOrderQuantity: 10,
    tiers: [
      { minimumQuantity: 10, maximumQuantity: 499, unitAmountMinor: 130 },
      { minimumQuantity: 500, unitAmountMinor: 120 },
    ],
  };
  const result = planCatalogDetailApproval({
    ...input,
    variants: [
      priced('a', { mode: 'fixed', currency: 'USD', amountMinor: 125 }),
      priced('b', tiers),
      priced('c', { mode: 'unavailable' }),
    ],
  });
  assert.deepEqual(result.publication.priceSummary, {
    source: 'sku',
    variantId: 'b',
    pricing: tiers,
  });
});

test('a website price becomes the summary; no price anywhere stores no summary', () => {
  const input = fixture();
  const manual = { ...input.product, catalogPricingMode: 'manual', unitPrice: 3.1, moq: 1000 };
  assert.deepEqual(
    planCatalogDetailApproval({ ...input, product: manual }).publication.priceSummary,
    {
      source: 'website',
      pricing: { mode: 'fixed', currency: 'USD', amountMinor: 310, minimumOrderQuantity: 1000 },
    },
  );
  assert.equal(Object.hasOwn(planCatalogDetailApproval(input).publication, 'priceSummary'), false);
});

test('a one-page partial plan (staged approval) does not throw while deriving the summary', () => {
  const input = fixture();
  assert.doesNotThrow(() =>
    planCatalogDetailApproval({ ...input, variants: input.variants.slice(0, 1) }),
  );
});

test('unused supplier text does not block the effective website version or restore supplier notes', () => {
  const input = fixture();
  const source = {
    ...input.product.detailSourceCandidate,
    name: 'Supplier '.repeat(80).trim(),
    descriptionText: 'x'.repeat(30001),
  };
  const product = {
    ...input.product,
    description: 'Reviewed replacement',
    detailSourceCandidate: source,
  };
  const result = planCatalogDetailApproval({ ...input, product });
  assert.equal(result.publication.header.name, 'Reviewed title');
  assert.equal(result.publication.header.descriptionText, 'Reviewed replacement');
  assert.equal(result.publication.content, undefined);
  assert.equal(result.publication.noteBlocks, undefined);
  assert.equal(product.detailSourceCandidate.descriptionText.length, 30001);
  assert.equal(JSON.stringify(result).includes(source.name), false);
});

test('effective website failures retain safe measurements without source values in exceptions', () => {
  const input = fixture();
  input.product.description = '秘密'.repeat(15001);
  assert.throws(
    () => planCatalogDetailApproval(input),
    (error: unknown) => {
      assert.ok(error instanceof CatalogValidationError);
      assert.deepEqual(error.issues, [
        {
          code: 'TOO_LONG',
          stage: 'effective-content',
          path: 'descriptionText',
          severity: 'error',
          remedy: 'edit',
          expected: { maxChars: 30000 },
          observed: { chars: 30002, bytes: 90006 },
        },
      ]);
      assert.equal(JSON.stringify(error).includes('秘密'), false);
      assert.equal(error.message.includes('秘密'), false);
      return true;
    },
  );
});

test('stored source failures use the same public field and recovery action as preparation', () => {
  const input = fixture();
  const product = {
    ...input.product,
    detailSourceCandidate: {
      ...input.product.detailSourceCandidate,
      facts: [{ name: 'Private source fact', value: 'x'.repeat(2001) }],
    },
  };
  assert.throws(
    () => planCatalogDetailApproval({ ...input, product }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogValidationError);
      assert.equal(error.issues[0]?.path, 'facts.0.value');
      assert.equal(error.issues[0]?.remedy, 'resync');
      assert.deepEqual(error.issues[0]?.expected, { maxChars: 2000 });
      assert.deepEqual(error.issues[0]?.observed, { chars: 2001, bytes: 2001 });
      assert.doesNotMatch(JSON.stringify(error), /Private source fact|detailSourceCandidate/);
      return true;
    },
  );
});

test('configuration UTF-8 capacity accepts the exact limit and rejects one extra byte', () => {
  const variant = {
    id: 'variant',
    sku: 'SKU',
    images: [],
    offers: [],
    inventory: { state: 'unknown' as const },
    options: Array.from({ length: 44 }, (_, index) => ({
      name: `Option ${index}`,
      value: index < 42 ? '中'.repeat(1000) : index === 42 ? 'x' : '',
    })),
  };
  const tail = variant.options.at(-1);
  assert.ok(tail);
  const remaining =
    CATALOG_DETAIL_VARIANT_MAX_BYTES - new TextEncoder().encode(JSON.stringify(variant)).byteLength;
  assert.ok(remaining > 0 && remaining < 6000);
  tail.value = '中'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
  const valid = CatalogDetailVariantSchema.parse(variant);
  assert.equal(new TextEncoder().encode(JSON.stringify(valid)).byteLength, 128 * 1024);
  assert.deepEqual(catalogVariantCapacityIssues([valid]), []);
  tail.value += 'x';
  const oversized = CatalogDetailVariantSchema.parse(variant);
  const issues = catalogVariantCapacityIssues([oversized]);
  assert.equal(issues[0]?.code, 'TOO_LARGE');
  assert.deepEqual(issues[0]?.expected, { maxBytes: 128 * 1024 });
  assert.deepEqual(issues[0]?.observed, { bytes: 128 * 1024 + 1 });
  assert.equal(tail.value.endsWith('x'), true);
});

for (const [caseName, options] of [
  [
    'repeated names',
    [
      { name: 'Color', value: 'Black' },
      { name: 'Color', value: 'White' },
      { name: 'Size', value: 'Small' },
      { name: 'Size', value: 'Large' },
    ],
  ],
  [
    'numeric names in source order',
    [
      { name: '10', value: 'First' },
      { name: '2', value: 'Second' },
      { name: '01', value: 'Third' },
    ],
  ],
  [
    'prototype-shaped names',
    [
      { name: '__proto__', value: 'ABS' },
      { name: 'constructor', value: 'Metal' },
      { name: 'toString', value: 'Quartz' },
    ],
  ],
] as const) {
  test(`approval preserves complete source options with ${caseName}`, () => {
    const input = fixture();
    const base = input.variants[0];
    assert.ok(base);
    const row = {
      ...base,
      detailSourceOwner: 'alibaba:source',
      optionValues: Object.fromEntries(options.map((option) => [option.name, option.value])),
      detailSourceCandidate: { ...base.detailSourceCandidate, options },
    };
    const product = { ...input.product, detailSourceOwner: row.detailSourceOwner };
    const before = structuredClone(row);
    const plan = planCatalogDetailApproval({ ...input, product, variants: [row] });
    assert.deepEqual(plan.variants[0]?.options, options);
    assert.equal(plan.variants[0]?.sku, row.sku);
    assert.deepEqual(plan.variants[0]?.images, ['/api/images/image']);
    assert.deepEqual(row, before);
    assert.equal(Reflect.get({}, 'polluted'), undefined);
  });
}

test('legacy canonical overrides still take precedence when they differ from the source mirror', () => {
  const input = fixture();
  const base = input.variants[0];
  assert.ok(base);
  for (const owner of ['source-owner', 'alibaba:source', 'manual:product']) {
    const row = { ...base, detailSourceOwner: owner };
    const plan = planCatalogDetailApproval({
      ...input,
      product: { ...input.product, detailSourceOwner: owner },
      variants: [row],
    });
    assert.deepEqual(plan.variants[0]?.options, [{ name: 'Color', value: 'Blue' }]);
  }
});

test('manual and legacy canonical option dictionaries retain prototype-shaped own keys', () => {
  const input = fixture();
  const base = input.variants[0];
  assert.ok(base);
  const optionValues: unknown = JSON.parse(
    '{"__proto__":"ABS","constructor":"Metal","Color":"Black"}',
  );
  const dictionaries: unknown[] = [
    optionValues,
    Object.setPrototypeOf(structuredClone(optionValues), null),
  ];
  for (const values of dictionaries) {
    const row: unknown = { ...base, optionValues: values };
    const before: string = JSON.stringify(row);
    const plan = planCatalogDetailApproval({ ...input, variants: [row] });
    assert.deepEqual(plan.variants[0]?.options, [
      { name: '__proto__', value: 'ABS' },
      { name: 'constructor', value: 'Metal' },
      { name: 'Color', value: 'Black' },
    ]);
    assert.equal(JSON.stringify(row), before);
  }
});

test('non-dictionaries and non-string prototype-shaped values cannot become successful empty options', () => {
  const input = fixture();
  const base = input.variants[0];
  assert.ok(base);
  for (const optionValues of [
    new Date(),
    new Map([['Color', 'Black']]),
    Object.create({ Color: 'Inherited' }),
    [['Color', 'Black']],
    JSON.parse('{"__proto__":2}'),
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) {
    assert.throws(
      () => planCatalogDetailApproval({ ...input, variants: [{ ...base, optionValues }] }),
      CatalogValidationError,
    );
  }
});
