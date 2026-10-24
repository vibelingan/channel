import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCatalogProductDetail } from '@vibelingan-channel/shared/catalog-detail';
import {
  type CatalogDetailBindings,
  buildCatalogDetailCandidate,
  buildCompleteCatalogPreparationPlan,
} from './detail-candidate.ts';
import {
  dianxiaomiObservationAdapter,
  parseDianxiaomiWorkbook,
} from './providers/dianxiaomi/adapter.ts';
import type { CatalogSourceObservation } from './source-observations.ts';
import { clockFactsSamples } from './testing/clock-source-facts.ts';
import { buildAcceptanceWorkbook } from './testing/dianxiaomi-acceptance-fixture.ts';

function observation(provider: 'alibaba' | 'dianxiaomi' = 'alibaba'): CatalogSourceObservation {
  return {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider,
      sourceProductKey: 'private-parent',
      accountKey: 'private-account',
      observedAt: '2026-09-06T00:00:00.000Z',
      captureMode: 'selected',
      completeness: 'full-product',
    },
    identity: {
      title: 'Headset',
      matchHints: {},
      attributes: [{ sourceName: 'Material', value: 'ABS' }],
    },
    content: {
      media: [{ sourceUrl: 'https://example.com/private.jpg', position: 0, role: 'primary' }],
      description: {
        text: 'Safe text',
        sanitizedHtml: '<b>Safe text</b>',
        placeholder: false,
        sanitized: true,
        provenance: 'description',
      },
    },
    lifecycle: { sourceListingStatus: 'published' },
    variants: [
      {
        sourceVariantKey: 'private-blue',
        sku: 'BLUE',
        media: [],
        options: [{ sourceName: 'Color', value: 'Blue' }],
        inventory: [{ quantity: 0, semantics: 'sellable' }],
      },
    ],
    offers: [
      {
        sourceOfferKey: 'private-offer',
        sourceVariantKey: 'private-blue',
        kind: 'supplier',
        pricing: {
          mode: 'tiered',
          currency: 'USD',
          tiers: [
            { minimumQuantity: 10, maximumQuantity: 99, unitAmountMinor: 1200 },
            { minimumQuantity: 100, unitAmountMinor: 1100 },
          ],
        },
      },
    ],
    evidence: [{ kind: 'raw-payload', evidenceId: 'private-evidence' }],
    warnings: [],
  };
}
const bindings = (): CatalogDetailBindings => ({
  productId: 'product-1',
  variants: new Map([['private-blue', 'variant-1']]),
  images: new Map([['https://example.com/private.jpg', 'image-1']]),
});

test('actual Excel parser and adapter outputs cross the same detail decoder', () => {
  const imported = parseDianxiaomiWorkbook(buildAcceptanceWorkbook());
  const batch = dianxiaomiObservationAdapter.toObservations({
    bundle: imported.bundle,
    storeListings: imported.storeListings,
    observedAt: '2026-09-06T00:00:00.000Z',
  });
  assert.ok(batch.observations.length > 0);
  for (const [index, item] of batch.observations.entries()) {
    const result = buildCatalogDetailCandidate(item, {
      productId: `local-product-${index}`,
      variants: new Map(
        item.variants.map((v, i) => [v.sourceVariantKey, `local-variant-${index}-${i}`]),
      ),
      images: new Map(),
    });
    assert.ok(result.ok, result.ok ? undefined : result.errors.join('; '));
  }
});

test('both providers produce the same DTO without provider-specific rendering', () => {
  const a = buildCatalogDetailCandidate(observation(), bindings());
  const b = buildCatalogDetailCandidate(observation('dianxiaomi'), bindings());
  assert.deepEqual(a, b);
  assert.ok(a.ok);
  assert.deepEqual(a.value.images, ['/api/images/image-1']);
  assert.equal(a.value.variants.items[0]?.offers[0]?.pricing.mode, 'tiered');
  assert.deepEqual(a.value.variants.items[0]?.inventory, {
    state: 'reported',
    basis: 'source',
    quantity: 0,
    semantics: 'sellable',
  });
  for (const value of [
    'private-parent',
    'private-account',
    'private-evidence',
    'private-offer',
    'private-blue',
    'https://example.com',
    'sanitizedHtml',
  ]) {
    assert.equal(JSON.stringify(a).includes(value), false, value);
  }
});

test('malformed input fails safely; missing optional data is not fabricated', () => {
  for (const input of ['', null, undefined, [], {}, 0])
    assert.equal(buildCatalogDetailCandidate(input, bindings()).ok, false);
  const item = observation();
  item.content = { media: [] };
  const variant = item.variants[0];
  assert.ok(variant);
  variant.sku = undefined;
  item.offers = [];
  const result = buildCatalogDetailCandidate(item, bindings());
  assert.ok(result.ok);
  assert.equal(result.value.descriptionText, undefined);
  assert.deepEqual(result.value.variants.items[0]?.offers, []);
  assert.equal(result.value.categoryLabel, undefined);
});

test('unknown stock differs from zero; conflicting values are never added', () => {
  const item = observation();
  const variant = item.variants[0];
  assert.ok(variant);
  for (const [values, state] of [
    [[], 'unknown'],
    [[{ quantity: 0, semantics: 'unknown' as const }], 'unknown'],
    [
      [
        { quantity: 3, semantics: 'sellable' as const },
        { quantity: 4, semantics: 'sellable' as const },
      ],
      'conflict',
    ],
  ] as const) {
    variant.inventory = [...values];
    const result = buildCatalogDetailCandidate(item, bindings());
    assert.ok(result.ok);
    assert.deepEqual(result.value.variants.items[0]?.inventory, { state });
  }
});

test('unbound and hostile image bindings cannot expose private storage', () => {
  for (const target of [undefined, 'https://storage.example/private', '../secret']) {
    const bound = bindings();
    const result = buildCatalogDetailCandidate(observation(), {
      ...bound,
      images: new Map(target ? [['https://example.com/private.jpg', target]] : []),
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.images, []);
    assert.equal(result.warnings.length, 1);
  }
});

test('all variants require unique canonical bindings, including outside the displayed page', () => {
  const item = observation();
  const variant = item.variants[0];
  assert.ok(variant);
  item.variants.push({ ...variant, sourceVariantKey: 'private-red' });
  assert.equal(buildCatalogDetailCandidate(item, bindings(), 1, 1).ok, false);
  assert.equal(
    buildCatalogDetailCandidate(item, {
      ...bindings(),
      variants: new Map([
        ['private-blue', 'same'],
        ['private-red', 'same'],
      ]),
    }).ok,
    false,
  );
});

test('more than 50 variants are explicitly paged, never silently truncated', () => {
  const item = observation();
  const variant = item.variants[0];
  assert.ok(variant);
  item.offers = [];
  item.variants = Array.from({ length: 51 }, (_, i) => ({
    ...variant,
    sourceVariantKey: `source-${i}`,
  }));
  const bound = {
    ...bindings(),
    variants: new Map(item.variants.map((v, i) => [v.sourceVariantKey, `canonical-${i}`])),
  };
  const first = buildCatalogDetailCandidate(item, bound);
  const last = buildCatalogDetailCandidate(item, bound, 2);
  assert.ok(first.ok && last.ok);
  assert.equal(first.value.variants.items.length, 50);
  assert.equal(first.value.variants.total, 51);
  assert.equal(first.value.variants.hasMore, true);
  assert.equal(last.value.variants.items.length, 1);
  assert.equal(last.value.variants.hasMore, false);
  for (const page of [0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER])
    assert.equal(buildCatalogDetailCandidate(item, bound, page).ok, false);
});

test('decoder rejects private keys, invalid page metadata, and unsafe image paths', () => {
  const result = buildCatalogDetailCandidate(observation(), bindings());
  assert.ok(result.ok);
  for (const value of [
    { ...result.value, raw: {} },
    { ...result.value, images: ['javascript:alert(1)'] },
    { ...result.value, variants: { ...result.value.variants, hasMore: true } },
  ])
    assert.equal(decodeCatalogProductDetail(value).ok, false);
});

test('a product-level offer does not become a fabricated SKU-specific offer', () => {
  const item = observation();
  const offer = item.offers[0];
  assert.ok(offer);
  offer.sourceVariantKey = undefined;
  const result = buildCatalogDetailCandidate(item, bindings());
  assert.ok(result.ok);
  assert.equal(result.value.offers.length, 1);
  assert.equal(result.value.variants.items[0]?.offers.length, 0);
});

test('invalid IDs are rejected even when their variant is outside the current page', () => {
  const item = observation();
  const variant = item.variants[0];
  assert.ok(variant);
  item.variants.push({ ...variant, sourceVariantKey: 'private-red' });
  for (const id of [' ', ' padded ', 'x'.repeat(201)]) {
    const result = buildCatalogDetailCandidate(
      item,
      {
        ...bindings(),
        variants: new Map([
          ['private-blue', 'canonical-blue'],
          ['private-red', id],
        ]),
      },
      1,
      1,
    );
    assert.equal(result.ok, false);
    assert.equal(
      buildCatalogDetailCandidate(observation(), { ...bindings(), productId: id }).ok,
      false,
    );
  }
});

test('zero variants is an explicit empty page and excess gallery images carry a warning', () => {
  const item = observation();
  item.variants = [];
  item.offers = [];
  item.content.media = Array.from({ length: 10 }, (_, i) => ({
    sourceUrl: `https://example.com/${i}.jpg`,
    position: i,
    role: 'gallery',
  }));
  const result = buildCatalogDetailCandidate(item, {
    ...bindings(),
    images: new Map(item.content.media.map((v, i) => [v.sourceUrl, `image-${i}`])),
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.variants, {
    items: [],
    total: 0,
    page: 1,
    pageSize: 50,
    hasMore: false,
  });
  assert.equal(result.value.images.length, 9);
  assert.deepEqual(result.warnings, ['gallery-limited-to-nine']);
});

test('malformed money fails the common boundary instead of becoming a display number', () => {
  const valid = buildCatalogDetailCandidate(observation(), bindings());
  assert.ok(valid.ok);
  for (const pricing of [
    null,
    '',
    {},
    { mode: 'fixed', currency: 'USD', amountMinor: -1 },
    { mode: 'fixed', currency: 'USD', amountMinor: 0.5 },
    { mode: 'fixed', currency: 'USD', amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { mode: 'range', currency: 'USD', minimumAmountMinor: 20, maximumAmountMinor: 10 },
    {
      mode: 'tiered',
      currency: 'USD',
      tiers: [
        { minimumQuantity: 1, maximumQuantity: 10, unitAmountMinor: 100 },
        { minimumQuantity: 10, unitAmountMinor: 90 },
      ],
    },
  ]) {
    assert.equal(
      decodeCatalogProductDetail({
        ...valid.value,
        offers: [{ kind: 'supplier', basis: 'source-quote', pricing }],
      }).ok,
      false,
    );
  }
});

for (const field of ['title', 'description'] as const) {
  test(`website-owned ${field} is applied before the shared detail validation`, () => {
    const item = observation();
    if (field === 'title') item.identity.title = 'Unused supplier title '.repeat(30).trim();
    else {
      assert.ok(item.content.description);
      item.content.description = { ...item.content.description, text: 'x'.repeat(30001) };
    }
    const bound = {
      ...bindings(),
      websiteProduct: {
        _id: 'product-1',
        name: 'Reviewed website title',
        description: 'Reviewed website text',
        imageIds: ['image-1'],
        detailSourceOwner: 'alibaba:private-parent',
      },
    };
    const result = buildCatalogDetailCandidate(item, bound);
    assert.ok(result.ok, result.ok ? undefined : result.errors.join('; '));
    assert.equal(result.value.name, 'Reviewed website title');
    assert.equal(result.value.descriptionText, 'Reviewed website text');
    assert.equal(
      item.content.description?.text?.length,
      field === 'description' ? 30001 : 9,
      'source evidence remains complete',
    );
  });
}

test('effective website validation still rejects an invalid chosen description', () => {
  const bound = {
    ...bindings(),
    websiteProduct: {
      _id: 'product-1',
      name: 'Reviewed',
      description: 'x'.repeat(30001),
      imageIds: ['image-1'],
      detailSourceOwner: 'alibaba:private-parent',
    },
  };
  const result = buildCatalogDetailCandidate(observation(), bound);
  assert.equal(result.ok, false);
});

test('website field ownership cannot cross product identities', () => {
  const bound = {
    ...bindings(),
    websiteProduct: {
      _id: 'another-product',
      name: 'Other product',
      description: 'Other text',
      imageIds: ['other-image'],
      detailSourceOwner: 'alibaba:private-parent',
    },
  };
  assert.equal(buildCatalogDetailCandidate(observation(), bound).ok, false);
});

for (const sample of clockFactsSamples) {
  test(`stored ${sample.specimen} multi-value specifications remain complete in a valid candidate`, () => {
    const item = observation();
    item.identity.attributes = sample.attributes;
    const before = structuredClone(item);
    const result = buildCatalogDetailCandidate(item, bindings());
    assert.ok(result.ok, result.ok ? undefined : result.errors.join('; '));
    assert.equal(result.value.facts.length, sample.attributes.length);
    assert.deepEqual(
      result.value.facts,
      sample.attributes.map((fact) => ({
        name: fact.sourceName,
        value: String(fact.value).trim(),
      })),
    );
    assert.deepEqual(item, before, 'private observation is unchanged');
  });
}

test('source facts keep every conflicting and duplicate row with its original order', () => {
  const item = observation();
  item.identity.attributes = [
    { sourceName: 'Finish', value: 'Matte', canonicalKey: 'finish' },
    { sourceName: 'Power', value: 0 },
    { sourceName: 'Finish', value: 'Gloss', canonicalKey: 'finish' },
    { sourceName: 'Finish', value: 'Matte', canonicalKey: 'finish' },
    { sourceName: 'Power', value: false },
    { sourceName: 'Finish', value: 'Other context', canonicalKey: 'other-finish' },
    { sourceName: 'finish', value: 'Lowercase' },
  ];
  const result = buildCatalogDetailCandidate(item, bindings());
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.facts,
    item.identity.attributes.map((fact) => ({
      name: fact.sourceName,
      value: String(fact.value),
    })),
  );
  assert.deepEqual(result.value.variants.items[0]?.options, [{ name: 'Color', value: 'Blue' }]);
});

test('source fact capacity is bounded without truncating values or retaining only the first page', () => {
  const item = observation();
  item.identity.attributes = Array.from({ length: 256 }, (_, i) => ({
    sourceName: `Fact ${i}`,
    value: i === 255 ? 'Last value' : 'Value',
  }));
  const result = buildCatalogDetailCandidate(item, bindings());
  assert.ok(result.ok);
  assert.equal(result.value.facts.length, 256);
  assert.deepEqual(result.value.facts.at(-1), { name: 'Fact 255', value: 'Last value' });
  item.identity.attributes.push({ sourceName: 'Fact 256', value: 'Beyond capacity' });
  assert.equal(buildCatalogDetailCandidate(item, bindings()).ok, false, 'never truncate at 256');
  item.identity.attributes = [{ sourceName: 'Value boundary', value: 'x'.repeat(2000) }];
  assert.equal(buildCatalogDetailCandidate(item, bindings()).ok, true);
  item.identity.attributes[0] = { sourceName: 'Value boundary', value: 'x'.repeat(2001) };
  assert.equal(buildCatalogDetailCandidate(item, bindings()).ok, false);
});

for (const count of [21, 105]) {
  for (const fault of ['sku', 'options', 'offers'] as const) {
    test(`first preparation page rejects ${fault} outside its visible page (${count} configurations)`, () => {
      const item = observation();
      const original = item.variants[0];
      assert.ok(original);
      item.variants = Array.from({ length: count }, (_, index) => ({
        ...structuredClone(original),
        sourceVariantKey: `private-${index}`,
        sku: `SKU-${index}`,
      }));
      item.offers = [];
      const last = item.variants.at(-1);
      assert.ok(last);
      if (fault === 'sku') last.sku = 'x'.repeat(201);
      if (fault === 'options')
        last.options = Array.from({ length: 51 }, (_, index) => ({
          sourceName: `Option ${index}`,
          value: 'Value',
        }));
      if (fault === 'offers')
        item.offers = Array.from({ length: 33 }, (_, index) => ({
          sourceOfferKey: `private-offer-${index}`,
          sourceVariantKey: last.sourceVariantKey,
          kind: 'supplier',
          pricing: { mode: 'fixed', currency: 'USD', amountMinor: index + 1 },
        }));
      const bound = {
        ...bindings(),
        variants: new Map(
          item.variants.map((variant, index) => [variant.sourceVariantKey, `variant-${index}`]),
        ),
      };
      const before = structuredClone(item);
      const result = buildCatalogDetailCandidate(item, bound, 1, 20);
      assert.equal(
        result.ok,
        false,
        'all configurations must be valid before the first page is staged',
      );
      assert.deepEqual(item, before, 'private source remains complete');
    });
  }
}

test('105 valid configurations keep exact offer ownership, order and paging', () => {
  const item = observation();
  const original = item.variants[0];
  assert.ok(original);
  item.variants = Array.from({ length: 105 }, (_, index) => ({
    ...structuredClone(original),
    sourceVariantKey: `private-${index}`,
    sku: `SKU-${index}`,
  }));
  item.offers = item.variants.map((variant, index) => ({
    sourceOfferKey: `offer-${index}`,
    sourceVariantKey: variant.sourceVariantKey,
    kind: 'supplier',
    pricing: { mode: 'fixed', currency: 'USD', amountMinor: index + 1 },
  }));
  item.offers.push({
    sourceOfferKey: 'root',
    kind: 'supplier',
    pricing: { mode: 'fixed', currency: 'USD', amountMinor: 999 },
  });
  const bound = {
    ...bindings(),
    variants: new Map(
      item.variants.map((variant, index) => [variant.sourceVariantKey, `variant-${index}`]),
    ),
  };
  const ids: string[] = [];
  for (let page = 1; page <= 6; page++) {
    const result = buildCatalogDetailCandidate(item, bound, page, 20);
    assert.ok(result.ok, result.ok ? undefined : result.errors.join('; '));
    assert.equal(result.value.variants.total, 105);
    assert.equal(result.value.offers.length, 1);
    for (const [index, variant] of result.value.variants.items.entries()) {
      ids.push(variant.id);
      assert.equal(variant.offers.length, 1);
      assert.deepEqual(variant.offers[0]?.pricing, {
        mode: 'fixed',
        currency: 'USD',
        amountMinor: (page - 1) * 20 + index + 1,
      });
    }
  }
  assert.deepEqual(
    ids,
    item.variants.map((_, index) => `variant-${index}`),
  );
});

test('the complete configuration count uses the same 10000-row manifest bound', () => {
  const item = observation();
  item.offers = [];
  item.variants = Array.from({ length: 10000 }, (_, index) => ({
    sourceVariantKey: `private-${index}`,
    sku: `SKU-${index}`,
    options: [],
    inventory: [],
    media: [],
  }));
  const bound = {
    ...bindings(),
    variants: new Map(
      item.variants.map((variant, index) => [variant.sourceVariantKey, `variant-${index}`]),
    ),
  };
  const valid = buildCatalogDetailCandidate(item, bound, 1, 20);
  assert.ok(valid.ok);
  assert.equal(valid.value.variants.total, 10000);
  assert.equal(valid.value.variants.items.length, 20);
  item.variants.push({
    sourceVariantKey: 'private-overflow',
    sku: 'Overflow',
    options: [],
    inventory: [],
    media: [],
  });
  bound.variants.set('private-overflow', 'variant-overflow');
  assert.equal(buildCatalogDetailCandidate(item, bound, 1, 20).ok, false);
});

for (const count of [0, 1, 20, 21, 50, 105]) {
  test(`complete source plan keeps every one of ${count} configurations and the private source header`, () => {
    const source = observation();
    source.offers = [];
    source.variants = Array.from({ length: count }, (_, index) => ({
      sourceVariantKey: `source-${index}`,
      sku: `SKU-${index}`,
      media: [],
      inventory: [],
      options: [
        { sourceName: 'Color', value: `Color ${index}` },
        { sourceName: 'Color', value: 'Extra' },
      ],
    }));
    source.identity.title = 's'.repeat(1001);
    const before = structuredClone(source);
    const bound = {
      ...bindings(),
      variants: new Map(source.variants.map((v, i) => [v.sourceVariantKey, `variant-${i}`])),
      websiteProduct: {
        _id: 'product-1',
        name: 'Website title',
        description: 'Website description',
        detailSourceOwner: 'alibaba:source',
        imageIds: ['image-1'],
      },
    };
    const complete = buildCompleteCatalogPreparationPlan(source, bound);
    assert.ok(complete.ok);
    assert.equal(complete.value.header.name, 'Website title');
    assert.equal(complete.sourceHeader.name.length, 1001);
    assert.equal(complete.value.variants.length, count);
    assert.deepEqual(
      complete.value.variants.map((v) => v.sku),
      Array.from({ length: count }, (_, i) => `SKU-${i}`),
    );
    for (const variant of complete.value.variants) assert.equal(variant.options.length, 2);
    const folded = [];
    for (let page = 1; page <= Math.max(1, Math.ceil(count / 50)); page++) {
      const view = buildCatalogDetailCandidate(source, bound, page, 50);
      assert.ok(view.ok);
      assert.equal(Object.hasOwn(view, 'sourceHeader'), false);
      assert.equal(view.value.variants.total, count);
      folded.push(...view.value.variants.items);
    }
    assert.deepEqual(folded, complete.value.variants);
    assert.deepEqual(source, before);
  });
}
