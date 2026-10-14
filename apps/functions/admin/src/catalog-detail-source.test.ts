/** Admin prepare: manual products take the manual path (MIU-30). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { type AdapterListQuery, type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import type {
  ApprovalPersistenceCommand,
  ApprovalStageResult,
} from '@vibelingan-channel/db/catalog-detail-staging';
import { type CollectionDoc, type ListResult, matchesFilter } from '@vibelingan-channel/shared';
import { catalogFailureIssue } from '@vibelingan-channel/shared/catalog-issues';
import {
  completeSourceMirrorFixtures,
  sourceObservationFixture,
} from '../../alibaba-catalog-sync/src/testing/source-observation-fixture.ts';
import { prepareCatalogSource, sourceVariantIds } from './catalog-detail-source.ts';
import { CatalogValidationSchema, catalogValidationFailure } from './catalog-validation.ts';

class RecordingAdapter implements DbAdapter {
  commands: ApprovalPersistenceCommand[] = [];
  constructor(private readonly store: Record<string, CollectionDoc[]>) {
    completeSourceMirrorFixtures(store);
  }
  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    const filter = query.filter;
    const docs = (this.store[query.collection] ?? []).filter(
      (doc) => !filter || matchesFilter(doc, filter),
    );
    return {
      items: docs.slice(0, query.pageSize),
      total: docs.length,
      page: 1,
      pageSize: query.pageSize,
    };
  }
  async get(collection: string, id: string) {
    return (this.store[collection] ?? []).find((doc) => doc._id === id) ?? null;
  }
  async persistCatalogDetailApproval(
    _actorId: string,
    input: ApprovalPersistenceCommand,
  ): Promise<ApprovalStageResult> {
    this.commands.push(input);
    return { ok: true as const, jobId: 'j', revision: 'r', nextPage: 1, pages: 1, complete: true };
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
}

test('a manual product prepares through the manual command, once', async () => {
  const adapter = new RecordingAdapter({ products: [{ _id: 'm1', name: 'Kids headset' }] });
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', { action: 'prepare', productId: 'm1' });
  assert.deepEqual(result, {
    ok: true,
    jobId: 'j',
    revision: 'r',
    nextPage: 1,
    pages: 1,
    complete: true,
  });
  assert.deepEqual(adapter.commands, [
    { action: 'manual-source', productId: 'm1', configurationRowIds: [] },
  ]);
});

test('a manual product with configuration rows is refused before any write', async () => {
  const adapter = new RecordingAdapter({
    products: [{ _id: 'm1', name: 'Kids headset' }],
    productVariants: [
      { _id: 'row-1', productId: 'm1' },
      { _id: 'row-old', productId: 'm1', archived: true },
      { _id: 'other', productId: 'm2' },
    ],
  });
  setAdapter(adapter);
  assert.deepEqual(await prepareCatalogSource('admin', { action: 'prepare', productId: 'm1' }), {
    ok: false,
    code: 'MANUAL_CONFIGURATIONS',
  });
  assert.deepEqual(adapter.commands, []);
});

test('a linked product keeps the Alibaba prepare path', async () => {
  const adapter = new RecordingAdapter({
    products: [{ _id: 'p1', name: 'Synced', alibabaPrimarySourceKey: 'source-a' }],
  });
  setAdapter(adapter);
  // No stored observation: the Alibaba path answers SOURCE_NOT_READY, as before.
  assert.deepEqual(await prepareCatalogSource('admin', { action: 'prepare', productId: 'p1' }), {
    ok: false,
    code: 'SOURCE_NOT_READY',
  });
  assert.deepEqual(adapter.commands, []);
});

test('leftover rows from an earlier Alibaba link do not block a manual approval', async () => {
  // Unlinking keeps the Alibaba-owned configuration rows; they are not manual
  // configurations, so approving without them drops nothing the admin owns.
  const adapter = new RecordingAdapter({
    products: [{ _id: 'm1', name: 'Was synced' }],
    productVariants: [{ _id: 'v1', productId: 'm1', detailSourceOwner: 'alibaba:source-a' }],
  });
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', { action: 'prepare', productId: 'm1' });
  assert.equal(result.ok, true);
  assert.equal(adapter.commands.length, 1);
});

test('prepare sends our image ids for the supplier photos, null while one is not imported (MIU-39)', async () => {
  const url = (name: string) => `https://sc04.alicdn.com/${name}.jpg`;
  const observation = {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: 'source-a',
      externalProductId: '987',
      observedAt: '2026-10-01T00:00:00.000Z',
      captureMode: 'full',
      completeness: 'full-product',
    },
    identity: { title: 'Supplier title', matchHints: {}, attributes: [] },
    content: {
      description: {
        text: 'Comfortable headset',
        imageUrls: [url('c')],
        placeholder: false,
        sanitized: true,
        provenance: 'provider-description',
      },
      media: [
        { sourceUrl: url('a'), position: 1, role: 'gallery' },
        { sourceUrl: url('b'), position: 0, role: 'primary' },
      ],
    },
    lifecycle: { sourceListingStatus: 'published' },
    variants: [],
    offers: [],
    evidence: [{ kind: 'raw-payload', evidenceId: 'a'.repeat(64) }],
    warnings: [],
  };
  const link = (name: string) => ({
    _id: sourceMediaLinkId('alibaba', url(name)),
    provider: 'alibaba',
    sourceUrl: url(name),
    imageId: `img-${name}`,
  });
  const adapter = new RecordingAdapter({
    products: [
      {
        _id: 'p1',
        name: 'Synced',
        alibabaPrimarySourceKey: 'source-a',
        productFamily: 'headphones',
        imageIds: ['img-b', 'img-a'],
      },
    ],
    catalogSourceObservations: [
      { _id: sourceObservationDocumentId('alibaba', 'source-a'), observation },
    ],
    // The description photo "c" is not imported yet.
    catalogSourceLinks: [link('a'), link('b')],
  });
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', { action: 'prepare', productId: 'p1' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const command = adapter.commands[0] as { supplierMedia?: unknown };
  // In the supplier's order (by position), as an import would add them.
  assert.deepEqual(command.supplierMedia, { gallery: ['img-b', 'img-a'], descriptionImages: null });
});

test('an admin photo choice for a configuration replaces its supplier photos in prepare (DEC-20)', async () => {
  const url = (name: string) => `https://sc04.alicdn.com/${name}.jpg`;
  const observation = {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: 'source-a',
      externalProductId: '987',
      observedAt: '2026-10-01T00:00:00.000Z',
      captureMode: 'full',
      completeness: 'full-product',
    },
    identity: { title: 'Supplier title', matchHints: {}, attributes: [] },
    content: { media: [{ sourceUrl: url('a'), position: 0, role: 'primary' }] },
    lifecycle: { sourceListingStatus: 'published' },
    variants: ['white', 'black'].map((key) => ({
      sourceVariantKey: key,
      options: [{ sourceName: 'Color', value: key }],
      inventory: [],
      // Supplier photos never imported: without a choice these block approval.
      media: [{ sourceUrl: url(`${key}-sku`), position: 0, role: 'variant' }],
    })),
    offers: [],
    evidence: [{ kind: 'raw-payload', evidenceId: 'a'.repeat(64) }],
    warnings: [],
  };
  const variants = sourceVariantIds('p1', 'source-a', observation as never);
  const white = variants.get('white');
  const black = variants.get('black');
  assert.ok(white && black);
  const adapter = new RecordingAdapter({
    products: [
      {
        _id: 'p1',
        name: 'Synced',
        alibabaPrimarySourceKey: 'source-a',
        productFamily: 'headphones',
        imageIds: ['img-a', 'img-white'],
        // White: a gallery photo; black: a photo not in the gallery is ignored.
        configurationPhotos: { [white]: ['img-white'], [black]: ['img-elsewhere'] },
      },
    ],
    catalogSourceObservations: [
      { _id: sourceObservationDocumentId('alibaba', 'source-a'), observation },
    ],
    catalogSourceLinks: [
      {
        _id: sourceMediaLinkId('alibaba', url('a')),
        provider: 'alibaba',
        sourceUrl: url('a'),
        imageId: 'img-a',
      },
    ],
  });
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', { action: 'prepare', productId: 'p1' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const command = adapter.commands[0] as {
    variants: Array<{ id: string; images: string[] }>;
    variantMedia: Array<{ id: string; unboundSources: string[] }>;
  };
  const byId = (id: string) => command.variants.find((variant) => variant.id === id);
  const mediaById = (id: string) => command.variantMedia.find((media) => media.id === id);
  assert.deepEqual(byId(white)?.images, ['/api/images/img-white']);
  assert.deepEqual(mediaById(white)?.unboundSources, [], 'the choice replaces the supplier photos');
  assert.deepEqual(byId(black)?.images, []);
  assert.deepEqual(
    mediaById(black)?.unboundSources,
    [url('black-sku')],
    'unchanged without a valid choice',
  );
});

test('source projection validation preserves the failing field and performs no staging writes', async () => {
  const observation = {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: 'source-a',
      observedAt: '2026-10-13T00:00:00.000Z',
      captureMode: 'full',
      completeness: 'full-product',
    },
    identity: {
      title: 'Clock',
      matchHints: {},
      attributes: [{ sourceName: 'Material', value: 'private-marker-'.repeat(160) }],
    },
    content: { media: [] },
    lifecycle: { sourceListingStatus: 'published' },
    variants: [],
    offers: [],
    evidence: [{ kind: 'raw-payload', evidenceId: 'private-evidence' }],
    warnings: [],
  };
  const adapter = new RecordingAdapter({
    products: [
      { _id: 'clock', name: 'Clock', alibabaPrimarySourceKey: 'source-a', productFamily: 'misc' },
    ],
    catalogSourceObservations: [
      { _id: sourceObservationDocumentId('alibaba', 'source-a'), observation },
    ],
  });
  setAdapter(adapter);
  assert.deepEqual(await prepareCatalogSource('admin', { action: 'prepare', productId: 'clock' }), {
    ok: false,
    code: 'VALIDATION_ERROR',
    validation: {
      stage: 'source-candidate',
      issues: [
        {
          code: 'TOO_LONG',
          stage: 'effective-content',
          path: 'facts.0.value',
          severity: 'error',
          remedy: 'resync',
          expected: { maxChars: 2000 },
          observed: { chars: 2400, bytes: 2400 },
        },
      ],
      totalIssues: 1,
    },
  });
  assert.deepEqual(adapter.commands, []);
});

test('source-page schema failures identify the boundary before staging', async () => {
  const sourceUrl = 'https://sc04.alicdn.com/clock.jpg';
  const observation = {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: 'source-a',
      observedAt: '2026-10-13T00:00:00.000Z',
      captureMode: 'full',
      completeness: 'full-product',
    },
    identity: { title: 'Clock', matchHints: {}, attributes: [] },
    content: { media: [{ sourceUrl, role: 'primary', position: 0 }] },
    lifecycle: { sourceListingStatus: 'published' },
    variants: [],
    offers: [],
    evidence: [{ kind: 'raw-payload', evidenceId: 'evidence' }],
    warnings: [],
  };
  const adapter = new RecordingAdapter({
    products: [
      { _id: 'clock', name: 'Clock', alibabaPrimarySourceKey: 'source-a', productFamily: 'misc' },
    ],
    catalogSourceObservations: [
      { _id: sourceObservationDocumentId('alibaba', 'source-a'), observation },
    ],
    catalogSourceLinks: [
      {
        _id: sourceMediaLinkId('alibaba', sourceUrl),
        provider: 'alibaba',
        sourceUrl,
        imageId: 'x'.repeat(201),
      },
    ],
  });
  setAdapter(adapter);
  assert.deepEqual(await prepareCatalogSource('admin', { action: 'prepare', productId: 'clock' }), {
    ok: false,
    code: 'VALIDATION_ERROR',
    validation: {
      stage: 'source-page',
      issues: [
        {
          code: 'TOO_LONG',
          stage: 'source',
          path: 'supplierMedia.gallery.0',
          severity: 'error',
          remedy: 'system-repair',
          expected: { maxChars: 200 },
          observed: { chars: 201, bytes: 201 },
        },
      ],
      totalIssues: 1,
    },
  });
  assert.deepEqual(adapter.commands, []);
});

test('prepare retains private supplier text while validating the actual website description', async () => {
  const observation = {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: 'source-a',
      observedAt: '2026-10-13T00:00:00.000Z',
      captureMode: 'full',
      completeness: 'full-product',
    },
    identity: { title: 'Supplier '.repeat(80).trim(), matchHints: {}, attributes: [] },
    content: {
      media: [],
      description: {
        text: 'x'.repeat(30001),
        sanitizedHtml: '<p>Unused supplier notes</p>',
        placeholder: false,
        sanitized: true,
        provenance: 'provider-description',
      },
    },
    lifecycle: { sourceListingStatus: 'published' },
    variants: [],
    offers: [],
    evidence: [{ kind: 'raw-payload', evidenceId: 'evidence' }],
    warnings: [],
  };
  const adapter = new RecordingAdapter({
    products: [
      {
        _id: 'clock',
        name: 'Website clock',
        description: 'Reviewed clock description',
        alibabaPrimarySourceKey: 'source-a',
        productFamily: 'misc',
      },
    ],
    catalogSourceObservations: [
      { _id: sourceObservationDocumentId('alibaba', 'source-a'), observation },
    ],
  });
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', { action: 'prepare', productId: 'clock' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const command = adapter.commands[0];
  assert.ok(command?.action === 'source-page');
  assert.equal(command.header.descriptionText, observation.content.description.text);
  assert.equal(command.content, null);
  assert.equal(command.noteBlocks, null);
});

test('changing description ownership cannot reuse a preparation that omitted supplier content', async () => {
  const observation = {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: 'source-a',
      observedAt: '2026-10-13T00:00:00.000Z',
      captureMode: 'full',
      completeness: 'full-product',
    },
    identity: { title: 'Supplier', matchHints: {}, attributes: [] },
    content: {
      media: [],
      description: {
        text: 'Supplier text',
        sanitizedHtml: '<p>Supplier text</p>',
        placeholder: false,
        sanitized: true,
        provenance: 'provider-description',
      },
    },
    lifecycle: { sourceListingStatus: 'published' },
    variants: [],
    offers: [],
    evidence: [{ kind: 'raw-payload', evidenceId: 'evidence' }],
    warnings: [],
  };
  const product = {
    _id: 'p1',
    name: 'Website',
    description: 'My replacement',
    alibabaPrimarySourceKey: 'source-a',
  };
  const adapter = new RecordingAdapter({
    products: [product],
    catalogSourceObservations: [
      { _id: sourceObservationDocumentId('alibaba', 'source-a'), observation },
    ],
  });
  setAdapter(adapter);
  await prepareCatalogSource('admin', { action: 'prepare', productId: 'p1' });
  product.description = 'Supplier text';
  await prepareCatalogSource('admin', { action: 'prepare', productId: 'p1' });
  const [first, second] = adapter.commands;
  assert.ok(first?.action === 'source-page' && second?.action === 'source-page');
  assert.equal(first.content, null);
  assert.ok(
    second.content || second.noteBlocks,
    'supplier content is restored when explicitly adopted',
  );
  assert.notEqual(first.revision, second.revision, 'the old no-content cursor must not be reused');
});

function pairedSourceFixture() {
  const source = {
    _id: 'paired',
    connectionId: 'test',
    sourceProductId: 'external-paired',
    sourceTitle: 'Source clock',
    active: true,
    contentHash: 'a'.repeat(64),
    payloadId: 'capture-current',
  };
  const row = sourceObservationFixture(source);
  return {
    source,
    row,
    store: {
      products: [
        {
          _id: 'paired-product',
          name: 'Website clock',
          productFamily: 'misc',
          imageIds: ['image'],
          alibabaPrimarySourceKey: source._id,
          published: false,
          archived: false,
        },
      ],
      alibabaSourceProducts: [source],
      catalogSourceObservations: [row],
      images: [{ _id: 'image', status: 'active', storageProvider: 'local-disk' }],
    },
  };
}

test('actual prepare accepts a complete paired capture', async () => {
  const f = pairedSourceFixture();
  const adapter = new RecordingAdapter(f.store);
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', {
    action: 'prepare',
    productId: 'paired-product',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(adapter.commands.length, 1, 'the positive control reaches staging');
});

test('actual prepare refuses half-written, mismatched or removed captures before staging', async () => {
  for (const fault of ['hash', 'legacy-evidence', 'mirror-tombstone', 'both-tombstones'] as const) {
    const f = pairedSourceFixture();
    if (fault === 'hash') f.row.sourceContentHash = 'b'.repeat(64);
    if (fault === 'legacy-evidence') {
      const { sourceContentHash: _old, ...legacy } = f.row;
      f.store.catalogSourceObservations = [{ ...legacy, evidenceId: 'capture-old' }];
    }
    if (fault === 'mirror-tombstone' || fault === 'both-tombstones') f.source.active = false;
    if (fault === 'both-tombstones') f.row.active = false;
    const adapter = new RecordingAdapter(f.store);
    setAdapter(adapter);
    assert.deepEqual(
      await prepareCatalogSource('admin', { action: 'prepare', productId: 'paired-product' }),
      { ok: false, code: 'SOURCE_NOT_READY' },
      fault,
    );
    assert.equal(adapter.commands.length, 0, fault);
  }
});

test('actual prepare refuses a dangling Alibaba primary source even with a complete observation', async () => {
  const f = pairedSourceFixture();
  const adapter = new RecordingAdapter({ ...f.store, alibabaSourceProducts: [] });
  setAdapter(adapter);
  assert.deepEqual(
    await prepareCatalogSource('admin', { action: 'prepare', productId: 'paired-product' }),
    { ok: false, code: 'SOURCE_NOT_READY' },
  );
  assert.equal(adapter.commands.length, 0);
});

for (const fault of ['missing', 'other-product'] as const)
  test(`actual prepare refuses a ${fault} primary source link before staging`, async () => {
    const f = pairedSourceFixture();
    const adapter = new RecordingAdapter({
      ...f.store,
      alibabaProductLinks:
        fault === 'missing'
          ? []
          : [
              {
                _id: f.source._id,
                sourceKey: f.source._id,
                connectionId: f.source.connectionId,
                sourceProductId: f.source.sourceProductId,
                productId: 'another-product',
                linkedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
    });
    setAdapter(adapter);
    assert.deepEqual(
      await prepareCatalogSource('admin', { action: 'prepare', productId: 'paired-product' }),
      { ok: false, code: 'SOURCE_NOT_READY' },
    );
    assert.equal(adapter.commands.length, 0);
  });

for (const count of [21, 105])
  test(`prepare writes nothing when configuration ${count} fails the website contract`, async () => {
    const source = {
      _id: 'late-configuration',
      sourceKey: 'late-configuration',
      connectionId: 'fixture',
      sourceProductId: 'external',
      sourceTitle: 'Clock',
      active: true,
    };
    const row = sourceObservationFixture(source);
    const parsed = validateCatalogSourceObservation(row.observation);
    assert.ok(parsed.ok);
    row.observation = {
      ...parsed.value,
      variants: Array.from({ length: count }, (_, index) => ({
        sourceVariantKey: `private-${index}`,
        sku: index === count - 1 ? 'x'.repeat(201) : `SKU-${index}`,
        options: [],
        inventory: [],
        media: [],
      })),
      offers: [],
    };
    const adapter = new RecordingAdapter({
      products: [
        {
          _id: 'late-product',
          name: 'Clock',
          productFamily: 'misc',
          alibabaPrimarySourceKey: source._id,
          imageIds: [],
        },
      ],
      alibabaSourceProducts: [source],
      catalogSourceObservations: [row],
    });
    setAdapter(adapter);
    const result = await prepareCatalogSource('admin', {
      action: 'prepare',
      productId: 'late-product',
      page: 0,
    });
    assert.ok(!result.ok && result.code === 'VALIDATION_ERROR' && 'validation' in result);
    const validation = CatalogValidationSchema.parse(result.validation);
    assert.equal(validation.stage, 'source-candidate');
    assert.ok(validation.issues.some((issue) => issue.path === `variants.items.${count - 1}.sku`));
    assert.deepEqual(adapter.commands, []);
  });

test('invalid stored source data reports a safe field instead of a generic not-ready message', async () => {
  const source = {
    _id: 'invalid-capture',
    sourceKey: 'invalid-capture',
    connectionId: 'fixture',
    sourceProductId: 'external',
    sourceTitle: 'Clock',
    active: true,
  };
  const row = sourceObservationFixture(source);
  const parsed = validateCatalogSourceObservation(row.observation);
  assert.ok(parsed.ok);
  row.observation = {
    ...parsed.value,
    source: { ...parsed.value.source, observedAt: 'PRIVATE_SOURCE_TOKEN' },
  };
  const adapter = new RecordingAdapter({
    products: [
      { _id: 'clock', name: 'Clock', productFamily: 'misc', alibabaPrimarySourceKey: source._id },
    ],
    alibabaSourceProducts: [source],
    catalogSourceObservations: [row],
    alibabaProductLinks: [
      {
        _id: source._id,
        sourceKey: source._id,
        connectionId: source.connectionId,
        sourceProductId: source.sourceProductId,
        productId: 'clock',
        linkedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', { action: 'prepare', productId: 'clock' });
  assert.ok(!result.ok && result.code === 'VALIDATION_ERROR' && 'validation' in result);
  const validation = CatalogValidationSchema.parse(result.validation);
  assert.equal(validation.issues[0]?.path, 'source.observedAt');
  assert.equal(validation.issues[0]?.remedy, 'resync');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SOURCE_TOKEN/);
  assert.deepEqual(adapter.commands, []);
});

test('preparation preserves a persistence-stage structured rejection unchanged', async () => {
  const source = {
    _id: 'validation-source',
    sourceKey: 'validation-source',
    connectionId: 'fixture',
    sourceProductId: 'external',
    sourceTitle: 'Clock',
    active: true,
  };
  const adapter = new RecordingAdapter({
    products: [
      {
        _id: 'clock',
        name: 'Clock',
        productFamily: 'misc',
        alibabaPrimarySourceKey: source._id,
        imageIds: [],
      },
    ],
    alibabaSourceProducts: [source],
    catalogSourceObservations: [sourceObservationFixture(source)],
  });
  const failure = catalogValidationFailure('begin', [catalogFailureIssue('VALIDATION_ERROR')]);
  adapter.persistCatalogDetailApproval = async (_actorId, input) => {
    adapter.commands.push(input);
    return failure;
  };
  setAdapter(adapter);
  assert.deepEqual(
    await prepareCatalogSource('admin', { action: 'prepare', productId: 'clock' }),
    failure,
  );
  assert.equal(adapter.commands.length, 1);
});

test('first source page refuses a later oversized configuration before any persistence', async () => {
  const source = {
    _id: 'large-configuration',
    sourceKey: 'large-configuration',
    connectionId: 'fixture',
    sourceProductId: 'external',
    sourceTitle: 'Clock',
    active: true,
  };
  const row = sourceObservationFixture(source);
  const parsed = validateCatalogSourceObservation(row.observation);
  assert.ok(parsed.ok);
  row.observation = {
    ...parsed.value,
    variants: Array.from({ length: 21 }, (_, index) => ({
      sourceVariantKey: `source-${index}`,
      sku: `SKU-${index}`,
      inventory: [],
      media: [],
      options:
        index === 20
          ? Array.from({ length: 44 }, (_, position) => ({
              sourceName: `Option ${position}`,
              value: '中'.repeat(1000),
            }))
          : [],
    })),
    offers: [],
  };
  const before = structuredClone(row.observation);
  const adapter = new RecordingAdapter({
    products: [
      {
        _id: 'clock',
        name: 'Clock',
        productFamily: 'misc',
        alibabaPrimarySourceKey: source._id,
        imageIds: [],
      },
    ],
    alibabaSourceProducts: [source],
    catalogSourceObservations: [row],
  });
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', {
    action: 'prepare',
    productId: 'clock',
    page: 0,
  });
  assert.ok(!result.ok && result.code === 'VALIDATION_ERROR' && 'validation' in result);
  const validation = CatalogValidationSchema.parse(result.validation);
  assert.equal(validation.issues[0]?.code, 'TOO_LARGE');
  assert.equal(validation.issues[0]?.path, 'variants.items.20');
  assert.deepEqual(validation.issues[0]?.expected, { maxBytes: 128 * 1024 });
  assert.deepEqual(adapter.commands, []);
  assert.deepEqual(row.observation, before);
  assert.doesNotMatch(JSON.stringify(result), /中/);
});

test('malformed preparation requests identify safe fields and never persist', async () => {
  const adapter = new RecordingAdapter({});
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', {
    action: 'prepare',
    productId: 'p',
    page: -1,
    PRIVATE_KEY: 'PRIVATE_SOURCE_TOKEN',
  });
  assert.ok(!result.ok && result.code === 'VALIDATION_ERROR' && 'validation' in result);
  const validation = CatalogValidationSchema.parse(result.validation);
  assert.ok(validation.issues.some((issue) => issue.path === 'page' && issue.remedy === 'reload'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEY|PRIVATE_SOURCE_TOKEN/);
  assert.deepEqual(adapter.commands, []);
});

for (const action of ['prepare', 'preview'] as const) {
  test(`whole-job capacity is checked before source ${action}`, async () => {
    const source = {
      _id: 'large-header',
      sourceKey: 'large-header',
      connectionId: 'fixture',
      sourceProductId: 'external',
      sourceTitle: 'Clock',
      active: true,
    };
    const row = sourceObservationFixture(source);
    const parsed = validateCatalogSourceObservation(row.observation);
    assert.ok(parsed.ok);
    row.observation = {
      ...parsed.value,
      identity: {
        ...parsed.value.identity,
        attributes: Array.from({ length: 256 }, (_, i) => ({
          sourceName: `Fact ${i}`,
          value: '中'.repeat(1000),
        })),
      },
    };
    const before = structuredClone(row.observation);
    const adapter = new RecordingAdapter({
      products: [
        {
          _id: 'clock',
          name: 'Clock',
          productFamily: 'misc',
          alibabaPrimarySourceKey: source._id,
          imageIds: [],
        },
      ],
      alibabaSourceProducts: [source],
      catalogSourceObservations: [row],
      users: [{ _id: 'admin', role: 'admin' }],
    });
    setAdapter(adapter);
    const { readCatalogDetailPreview } = await import('./catalog-detail-preview.ts');
    const result =
      action === 'prepare'
        ? await prepareCatalogSource('admin', { action, productId: 'clock', page: 0 })
        : await readCatalogDetailPreview('admin', { action, productId: 'clock' });
    assert.ok(!result.ok && result.code === 'VALIDATION_ERROR' && 'validation' in result);
    const validation = CatalogValidationSchema.parse(result.validation);
    assert.equal(validation.issues[0]?.code, 'TOO_LARGE');
    assert.equal(validation.issues[0]?.path, 'data');
    assert.deepEqual(validation.issues[0]?.expected, { maxBytes: 512 * 1024 });
    assert.deepEqual(adapter.commands, []);
    assert.deepEqual(row.observation, before);
    assert.doesNotMatch(JSON.stringify(result), /中/);
  });
}

test('source capacity preflight decodes generation rather than casting unknown storage', async () => {
  for (const generation of [undefined, null, 0, 2, -1, '2', Number.MAX_SAFE_INTEGER + 1]) {
    const source = {
      _id: 'generation',
      sourceKey: 'generation',
      connectionId: 'fixture',
      sourceProductId: 'external',
      sourceTitle: 'Clock',
      active: true,
    };
    const adapter = new RecordingAdapter({
      products: [
        {
          _id: 'clock',
          name: 'Clock',
          alibabaPrimarySourceKey: source._id,
          imageIds: [],
          catalogContentGeneration: generation,
        },
      ],
      alibabaSourceProducts: [source],
      catalogSourceObservations: [sourceObservationFixture(source)],
    });
    setAdapter(adapter);
    const result = await prepareCatalogSource('admin', { action: 'prepare', productId: 'clock' });
    if (generation == null || generation === 0 || generation === 2) {
      assert.ok(result.ok);
      assert.equal(adapter.commands.length, 1);
    } else {
      assert.ok(!result.ok && result.code === 'VALIDATION_ERROR' && 'validation' in result);
      const report = CatalogValidationSchema.parse(result.validation);
      assert.equal(report.issues[0]?.path, 'catalogContentGeneration');
      assert.equal(report.issues[0]?.remedy, 'system-repair');
      assert.deepEqual(adapter.commands, []);
    }
  }
});
