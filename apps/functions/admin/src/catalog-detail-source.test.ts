/** Admin prepare: manual products take the manual path (MIU-30). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
} from '@vibelingan-channel/catalog-import/observations';
import { type AdapterListQuery, type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import type { ApprovalPersistenceCommand } from '@vibelingan-channel/db/catalog-detail-staging';
import { type CollectionDoc, type ListResult, matchesFilter } from '@vibelingan-channel/shared';
import { prepareCatalogSource, sourceVariantIds } from './catalog-detail-source.ts';

class RecordingAdapter implements DbAdapter {
  commands: ApprovalPersistenceCommand[] = [];
  constructor(private readonly store: Record<string, CollectionDoc[]>) {}
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
  async persistCatalogDetailApproval(_actorId: string, input: ApprovalPersistenceCommand) {
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
