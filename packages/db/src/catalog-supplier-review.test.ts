import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type CatalogSourceObservation,
  sourceMediaLinkId,
  sourceObservationDocumentId,
} from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  incomingDigest,
  publicationReview,
  readSupplierPhotoImageId,
} from './catalog-supplier-review.ts';

function fixture(reason: unknown = 'changed', photos = 0, overlap = false) {
  const urls = Array.from({ length: photos }, (_, i) => `https://sc04.alicdn.com/review-${i}.png`);
  const observation: CatalogSourceObservation = {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: 'source',
      externalProductId: '123',
      observedAt: '2026-10-01T00:00:00.000Z',
      captureMode: 'full',
      completeness: 'full-product',
    },
    identity: { title: 'Source', matchHints: {}, attributes: [] },
    content: {
      description: {
        text: 'Incoming description',
        imageUrls: overlap ? urls.slice(0, 18) : urls.slice(9),
        placeholder: false,
        sanitized: true,
        provenance: 'provider-description',
      },
      media: urls
        .slice(0, 9)
        .map((sourceUrl, position) => ({ sourceUrl, position, role: 'gallery' })),
    },
    lifecycle: { sourceListingStatus: 'published' },
    variants: [],
    offers: [],
    evidence: [{ kind: 'raw-payload', evidenceId: 'a'.repeat(64) }],
    warnings: [],
  };
  const observationId = sourceObservationDocumentId('alibaba', 'source');
  const product: CollectionDoc = {
    _id: 'p',
    description: 'Website description',
    imageIds: ['owned'],
    descriptionImageIds: [],
    alibabaPrimarySourceKey: 'source',
    alibabaReviewPending: true,
    alibabaReviewReason: reason,
    alibabaSourcePublicDigest: 'a'.repeat(64),
    supplierDecisions: {
      description: {
        choice: 'keep',
        incomingDigest: incomingDigest('description', 'Incoming description'),
      },
      gallery: { choice: 'keep', incomingDigest: incomingDigest('gallery', urls.slice(0, 9)) },
      descriptionImages: {
        choice: 'keep',
        incomingDigest: incomingDigest(
          'descriptionImages',
          observation.content.description?.imageUrls ?? [],
        ),
      },
    },
  };
  const row: CollectionDoc = { _id: observationId, observation };
  const links: CollectionDoc[] = urls.map((sourceUrl, i) => ({
    _id: sourceMediaLinkId('alibaba', sourceUrl),
    provider: 'alibaba',
    sourceUrl,
    imageId: `image-${i}`,
  }));
  const reads: { collection: string; id: string }[] = [];
  const reader = {
    get: async (collection: string, id: string) => {
      reads.push({ collection, id });
      return structuredClone(
        collection === 'catalogSourceObservations'
          ? row
          : (links.find((link) => link._id === id) ?? null),
      );
    },
  };
  return {
    product,
    observation,
    row,
    links,
    reads,
    reader,
    run: () => publicationReview(reader, product, 'source', 'a'.repeat(64)),
  };
}

test('a normal unflagged publication adds no review reads or acknowledgement fields', async () => {
  const h = fixture();
  h.product.alibabaReviewPending = false;
  assert.deepEqual(await h.run(), { ok: true, acknowledge: false });
  assert.equal(h.reads.length, 0);
});
for (const reason of ['new', null, undefined, 'edited'])
  test(`review ${String(reason)} does not inspect supplier photo links`, async () => {
    const h = fixture(reason, 27);
    if (reason === undefined) Reflect.deleteProperty(h.product, 'alibabaReviewReason');
    assert.deepEqual(await h.run(), { ok: true, acknowledge: true });
    assert.equal(h.reads.length, 1);
    assert.ok(h.reads.every((read) => read.collection === 'catalogSourceObservations'));
  });
for (const reason of ['changed', 'removed'])
  test(`${reason} review reads at most27 current photo links and one observation`, async () => {
    const h = fixture(reason, 27);
    assert.deepEqual(await h.run(), { ok: true, acknowledge: true });
    assert.equal(h.reads.length, 28);
    assert.equal(new Set(h.reads.map((read) => `${read.collection}/${read.id}`)).size, 28);
    assert.ok(
      h.reads.every((read) =>
        ['catalogSourceObservations', 'catalogSourceLinks'].includes(read.collection),
      ),
    );
  });
test('overlapping gallery and description URLs are read only once in a review', async () => {
  const h = fixture('changed', 18, true);
  assert.deepEqual(await h.run(), { ok: true, acknowledge: true });
  assert.equal(h.reads.length, 19);
});
for (const reason of ['future', ['new'], {}, false, 0])
  test(`a malformed or unknown review reason ${JSON.stringify(reason)} has a repair fallback`, async () => {
    const h = fixture(reason);
    const result = await h.run();
    assert.ok(
      !result.ok && result.validation?.issues.some((issue) => issue.remedy === 'system-repair'),
    );
    assert.equal(h.reads.length, 0);
  });
for (const part of ['description', 'gallery', 'descriptionImages'])
  for (const change of ['missing', 'stale', 'unapplied-incoming'])
    test(`current ${part} ${change} cannot acknowledge a review`, async () => {
      const h = fixture('changed', 27);
      const decisions = h.product.supplierDecisions;
      assert.ok(decisions && typeof decisions === 'object');
      if (change === 'missing') Reflect.deleteProperty(decisions, part);
      else
        Reflect.set(decisions, part, {
          choice: change === 'stale' ? 'keep' : 'incoming',
          incomingDigest:
            change === 'stale'
              ? 'f'.repeat(64)
              : incomingDigest(
                  part === 'description'
                    ? 'description'
                    : part === 'gallery'
                      ? 'gallery'
                      : 'descriptionImages',
                  part === 'description'
                    ? 'Incoming description'
                    : part === 'gallery'
                      ? h.observation.content.media.map((media) => media.sourceUrl)
                      : h.observation.content.description?.imageUrls,
                ),
        });
      const result = await h.run();
      assert.ok(
        !result.ok && result.validation?.issues.some((issue) => issue.remedy === 'review-change'),
      );
      assert.equal(h.product.alibabaReviewPending, true);
    });
for (const field of ['_id', 'provider', 'sourceUrl'])
  test(`photo binding with incorrect ${field} cannot make incoming photos appear applied`, async () => {
    const h = fixture('changed', 1);
    const link = h.links[0];
    assert.ok(link);
    link[field] = 'wrong';
    const reader = { get: async () => link };
    assert.equal(
      await readSupplierPhotoImageId(reader, 'https://sc04.alicdn.com/review-0.png'),
      undefined,
    );
  });
test('review photo reads preserve the existing alicdn HTTP transport normalization', async () => {
  const h = fixture('changed', 1);
  assert.equal(
    await readSupplierPhotoImageId(h.reader, 'http://sc04.alicdn.com/review-0.png'),
    'image-0',
  );
  assert.equal(h.reads.length, 1);
});
for (const failure of ['observation', 'link'])
  test(`an unknown ${failure} read error cannot be treated as review completion`, async () => {
    const h = fixture('changed', 27);
    const reader = {
      get: async (collection: string, id: string) => {
        if (
          collection ===
          (failure === 'observation' ? 'catalogSourceObservations' : 'catalogSourceLinks')
        )
          throw Error('review storage unavailable');
        return h.reader.get(collection, id);
      },
    };
    await assert.rejects(
      publicationReview(reader, h.product, 'source', 'a'.repeat(64)),
      /review storage unavailable/,
    );
    assert.equal(h.product.alibabaReviewPending, true);
  });
for (const shape of ['missing', 'bad-id', 'partial', 'other-source'])
  test(`a ${shape} current observation requires resync`, async () => {
    const h = fixture('new');
    if (shape === 'bad-id') h.row._id = 'other';
    if (shape === 'partial') h.observation.source.completeness = 'partial-product';
    if (shape === 'other-source') h.observation.source.sourceProductKey = 'other';
    const reader = shape === 'missing' ? { get: async () => null } : h.reader;
    const result = await publicationReview(reader, h.product, 'source', 'a'.repeat(64));
    assert.ok(!result.ok && result.validation?.issues.some((issue) => issue.remedy === 'resync'));
  });

test('an unlinked manual Edited review has no supplier queries', async () => {
  const h = fixture('edited');
  Reflect.deleteProperty(h.product, 'alibabaPrimarySourceKey');
  assert.deepEqual(await publicationReview(h.reader, h.product, null, undefined), {
    ok: true,
    acknowledge: true,
  });
  assert.equal(h.reads.length, 0);
});
