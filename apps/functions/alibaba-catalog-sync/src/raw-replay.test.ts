import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { alibabaOfferKey, alibabaSourceKey } from '@vibelingan-channel/alibaba-catalog-sync';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { type AlibabaRawReplayPort, replayAlibabaRawPage } from './raw-replay.ts';

const NOW = '2026-09-04T08:00:00.000Z';

test('versioned raw repair adds only the previously omitted product quote and preserves known MOQ', async () => {
  const f = fixture('local-raw-camping-light');
  f.bodyText = readFileSync(
    new URL('../../../../tests/fixtures/alibaba-camping-light-wire.json', import.meta.url),
    'utf8',
  );
  f.payloadId = createHash('sha256').update(f.bodyText).digest('hex');
  f.source.payloadId = f.payloadId;
  f.payload._id = f.payloadId;
  f.payload.responseSha256 = f.payloadId;
  f.payload.byteLength = Buffer.byteLength(f.bodyText);
  f.offer._id = alibabaOfferKey('channeltec', 'local-raw-camping-light', 'local-white-sku');
  f.offer.sourceSkuId = 'local-white-sku';
  const harness = port(f);
  const dry = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, harness.p);
  assert.ok(dry.ok);
  assert.equal(dry.ready, true);
  assert.equal(dry.counts.offers, 2);
  assert.equal(harness.updatedOffers.length, 0);
  const applied = await replayAlibabaRawPage(
    {
      mode: 'apply',
      limit: 10,
      expectedPageHash: dry.pageHash,
      expectedTotalSourceProducts: 1,
      manifestId: dry.manifestId,
    },
    harness.p,
  );
  assert.ok(applied.ok);
  assert.equal(applied.applied, 1);
  assert.equal(harness.updatedOffers.length, 2);
  const productOffer = harness.updatedOffers.find(
    (o) => o.id === alibabaOfferKey('channeltec', 'local-raw-camping-light'),
  );
  assert.ok(productOffer);
  assert.equal(Reflect.get(productOffer.patch.pricing as object, 'amountMinor'), 767);
  assert.equal(Reflect.get(productOffer.patch.pricing as object, 'sourceMoq'), 1);
  assert.equal(
    JSON.stringify(harness.observations[0]?.value).includes('raw-fixture-detail-16'),
    true,
  );
});

test('raw replay admits a missing sourcing FOB offer without admitting changed SKU identities', async () => {
  const f = fixture('sourcing-FOB');
  const wire = JSON.parse(f.bodyText);
  Object.assign(wire.alibaba_icbu_product_get_response.product, {
    product_type: 'sourcing',
    sourcing_trade: {
      fob_min_price: '7.75',
      fob_max_price: '9.0',
      fob_currency: 'USD',
      fob_unit_type: 'Piece',
      min_order_unit_type: 'Piece',
      min_order_quantity: '2.0',
    },
  });
  f.bodyText = JSON.stringify(wire);
  f.payloadId = createHash('sha256').update(f.bodyText).digest('hex');
  f.source.payloadId = f.payloadId;
  f.payload._id = f.payloadId;
  f.payload.responseSha256 = f.payloadId;
  f.payload.byteLength = Buffer.byteLength(f.bodyText);
  const harness = port(f);
  const dry = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, harness.p);
  assert.ok(dry.ok && dry.ready);
  assert.equal(dry.counts.offers, 2);
  const applied = await replayAlibabaRawPage(
    {
      mode: 'apply',
      limit: 10,
      expectedPageHash: dry.pageHash,
      expectedTotalSourceProducts: 1,
      manifestId: dry.manifestId,
    },
    harness.p,
  );
  assert.ok(applied.ok && applied.applied === 1);
  const productOffer = harness.updatedOffers.find(
    (o) => o.id === alibabaOfferKey('channeltec', 'sourcing-FOB'),
  );
  assert.ok(productOffer);
  assert.equal(Reflect.get(productOffer.patch.pricing as object, 'minAmountMinor'), 775);
  assert.equal(Reflect.get(productOffer.patch.pricing as object, 'maxAmountMinor'), 900);
  assert.equal(Reflect.get(productOffer.patch.pricing as object, 'sourceMoq'), 2);
  const changed = port(f);
  changed.p.listActiveOffers = async () => [{ ...f.offer, _id: 'unrelated-sku' }];
  const denied = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, changed.p);
  assert.ok(denied.ok);
  assert.equal(denied.ready, false);
  assert.equal(denied.failures[0]?.reason, 'offer-set-mismatch');
  assert.equal(changed.updatedOffers.length, 0);
});

function fixture(sourceProductId = 'live-product') {
  const bodyText = JSON.stringify({
    alibaba_icbu_product_get_response: {
      product: {
        product_id: sourceProductId,
        subject: 'Headset',
        description: '<p>Safe</p>',
        category_id: 44,
        status: 'approved',
        main_image: { images: { string: ['https://example.com/a.jpg'] } },
        sourcing_trade: { fob_currency: 'USD', min_order_quantity: 10 },
        product_sku: {
          sku_attributes: {
            sku_attribute: {
              attribute_id: 1,
              attribute_name: 'Color',
              values: { sku_attribute_value: { value_id: 10, system_value_name: 'Blue' } },
            },
          },
          skus: {
            sku_definition: {
              sku_id: 'sku-1',
              attr2_value: '{"1":10}',
              bulk_discount_prices: {
                bulk_discount_price: [{ start_quantity: 10, price: '12.00' }],
              },
            },
          },
        },
      },
    },
  });
  const payloadId = createHash('sha256').update(bodyText).digest('hex');
  const sourceKey = alibabaSourceKey('channeltec', sourceProductId);
  const source: CollectionDoc = {
    _id: sourceKey,
    sourceKey,
    connectionId: 'channeltec',
    sourceProductId,
    payloadId,
    fetchedAt: NOW,
    active: true,
    firstSeenRunId: 'full-original',
    lastSeenRunId: 'full-current',
  };
  const payload: CollectionDoc = {
    _id: payloadId,
    responseSha256: payloadId,
    endpointId: 'product.get',
    status: 'stored',
    byteLength: Buffer.byteLength(bodyText),
    storageFileId: 'cloud://bucket/alibaba-raw/body.json',
  };
  const offer: CollectionDoc = {
    _id: alibabaOfferKey('channeltec', sourceProductId, 'sku-1'),
    sourceKey,
    sourceProductId,
    sourceSkuId: 'sku-1',
    active: true,
    sourceAttributes: {},
  };
  return { bodyText, payloadId, sourceKey, source, payload, offer };
}

function port(f = fixture()) {
  const updatedOffers: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const observations: Array<{ id: string; value: Record<string, unknown> }> = [];
  const manifests = new Map<string, CollectionDoc>();
  const p: AlibabaRawReplayPort = {
    now: () => NOW,
    acquireLease: async () => ({ result: 'granted', fence: 3 }),
    renewLease: async () => true,
    releaseLease: async () => true,
    listSourceProducts: async () => ({ items: [f.source], total: 1 }),
    getDocument: async (collection, id) =>
      collection === 'alibabaSourcePayloads' && id === f.payloadId ? f.payload : null,
    getReplayManifest: async (id) => manifests.get(id) ?? null,
    listActiveOffers: async () => [f.offer],
    readObjectAsBase64: async () => ({ body: Buffer.from(f.bodyText).toString('base64') }),
    upsertOffer: async (id, patch) => {
      updatedOffers.push({ id, patch });
      return true;
    },
    upsertObservation: async (id, value, createOnly) => {
      observations.push({ id, value: { ...createOnly, ...value } });
      return true;
    },
    upsertReplayManifest: async (id, value, createOnly) => {
      manifests.set(id, { _id: id, ...createOnly, ...(manifests.get(id) ?? {}), ...value });
      return true;
    },
  };
  return { p, updatedOffers, observations, manifests };
}

test('dry-run reconstructs the exact current page without writing', async () => {
  const { p, updatedOffers, observations } = port();
  const result = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, p);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ready, true);
  assert.equal(result.totalSourceProducts, 1);
  assert.equal(result.manifestReady, true);
  assert.match(result.pageHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.counts, {
    sourceProducts: 1,
    observations: 1,
    variants: 1,
    offers: 1,
    attributedVariants: 1,
    attributePairs: 1,
    warnings: 0,
  });
  assert.deepEqual(result.priceModes, { tiered: 1 });
  assert.equal(updatedOffers.length, 0);
  assert.equal(observations.length, 0);
});

test('apply is rejected until the server manifest covers every dry-run page', async () => {
  const harness = port();
  harness.p.listSourceProducts = async () => ({ items: [fixture().source], total: 2 });
  const first = await replayAlibabaRawPage({ mode: 'dry-run', limit: 1 }, harness.p);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.manifestReady, false);
  assert.deepEqual(
    await replayAlibabaRawPage(
      {
        mode: 'apply',
        limit: 1,
        expectedPageHash: first.pageHash,
        expectedTotalSourceProducts: 2,
        manifestId: first.manifestId,
      },
      harness.p,
    ),
    { ok: false, reason: 'manifest-invalid' },
  );
  assert.equal(harness.updatedOffers.length, 0);
  assert.equal(harness.observations.length, 0);
});

test('apply requires the matching dry-run hash and preserves run provenance', async () => {
  const harness = port();
  const dry = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, harness.p);
  assert.equal(dry.ok, true);
  if (!dry.ok) return;

  const denied = await replayAlibabaRawPage(
    {
      mode: 'apply',
      limit: 10,
      expectedPageHash: '0'.repeat(64),
      expectedTotalSourceProducts: 1,
      manifestId: dry.manifestId,
    },
    harness.p,
  );
  assert.deepEqual(denied, { ok: false, reason: 'manifest-invalid' });
  assert.equal(harness.updatedOffers.length, 0);

  const applied = await replayAlibabaRawPage(
    {
      mode: 'apply',
      limit: 10,
      expectedPageHash: dry.pageHash,
      expectedTotalSourceProducts: 1,
      manifestId: dry.manifestId,
    },
    harness.p,
  );
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.equal(applied.applied, 1);
  assert.deepEqual(harness.updatedOffers[0]?.patch.sourceAttributes, { Color: 'Blue' });
  assert.equal(harness.updatedOffers[0]?.patch.parserVersion, 'alibaba-content-pricing-v4');
  assert.equal(Reflect.get(harness.updatedOffers[0]?.patch.pricing as object, 'sourceMoq'), 10);
  assert.equal(harness.observations.length, 1);
  assert.equal(harness.observations[0]?.value.lastSeenOperationId, 'full-current');
  assert.equal(harness.observations[0]?.value.firstSeenOperationId, 'full-original');

  const retried = await replayAlibabaRawPage(
    {
      mode: 'apply',
      limit: 10,
      expectedPageHash: dry.pageHash,
      expectedTotalSourceProducts: 1,
      manifestId: dry.manifestId,
    },
    harness.p,
  );
  assert.equal(retried.ok, true, 'a whole apply retry may replay an already committed page');
  if (!retried.ok) return;
  assert.equal(retried.applied, 1);
  assert.equal(harness.updatedOffers.length, 1, 'already committed page is not written twice');
  assert.equal(harness.observations.length, 1, 'observation upsert is not repeated either');
});

test('a manifest requires canonical instants and an exact two-hour expiry', async () => {
  for (const expiresAt of [
    'not-a-timestamp',
    '2026-02-30T08:00:00.000Z',
    'Thu, 04 Sep 2026 10:00:00 GMT',
    '9999-09-04T10:00:00.000Z',
    '2026-09-04T10:00:00.001Z',
  ]) {
    const harness = port();
    const dry = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, harness.p);
    assert.equal(dry.ok, true);
    if (!dry.ok) continue;
    const manifest = harness.manifests.get(dry.manifestId);
    assert.ok(manifest);
    manifest.expiresAt = expiresAt;
    assert.deepEqual(
      await replayAlibabaRawPage(
        {
          mode: 'apply',
          limit: 10,
          expectedPageHash: dry.pageHash,
          expectedTotalSourceProducts: 1,
          manifestId: dry.manifestId,
        },
        harness.p,
      ),
      { ok: false, reason: 'manifest-invalid' },
      expiresAt,
    );
  }
});

test('manifest status and apply cursor must describe the same committed prefix', async () => {
  const harness = port();
  const dry = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, harness.p);
  assert.equal(dry.ok, true);
  if (!dry.ok) return;
  const manifest = harness.manifests.get(dry.manifestId);
  assert.ok(manifest);
  manifest.status = 'ready';
  manifest.nextApplyIndex = 1;

  assert.deepEqual(
    await replayAlibabaRawPage(
      {
        mode: 'apply',
        limit: 10,
        expectedPageHash: dry.pageHash,
        expectedTotalSourceProducts: 1,
        manifestId: dry.manifestId,
      },
      harness.p,
    ),
    { ok: false, reason: 'manifest-invalid' },
  );
  assert.equal(
    harness.updatedOffers.length,
    0,
    'an impossible committed prefix cannot skip writes',
  );
  assert.equal(harness.observations.length, 0);
});

test('a manifest cannot claim it was created in the future', async () => {
  const harness = port();
  const dry = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, harness.p);
  assert.equal(dry.ok, true);
  if (!dry.ok) return;
  const manifest = harness.manifests.get(dry.manifestId);
  assert.ok(manifest);
  manifest.createdAt = '2026-09-04T09:00:00.000Z';
  manifest.expiresAt = '2026-09-04T11:00:00.000Z';

  assert.deepEqual(
    await replayAlibabaRawPage(
      {
        mode: 'apply',
        limit: 10,
        expectedPageHash: dry.pageHash,
        expectedTotalSourceProducts: 1,
        manifestId: dry.manifestId,
      },
      harness.p,
    ),
    { ok: false, reason: 'manifest-invalid' },
  );
});

test('an id mismatch blocks the whole page before any derived write', async () => {
  const f = fixture('provider-id');
  f.source.sourceProductId = 'mirror-id';
  const harness = port(f);
  const result = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, harness.p);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ready, false);
  assert.equal(result.failures[0]?.reason, 'product-id-mismatch');
  assert.equal(harness.updatedOffers.length, 0);
  assert.equal(harness.observations.length, 0);
});

test('apply reports a changed preflight reason before the generic page hash conflict', async () => {
  const harness = port();
  const dry = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, harness.p);
  assert.equal(dry.ok, true);
  if (!dry.ok) return;

  harness.p.listActiveOffers = async () => [];
  const result = await replayAlibabaRawPage(
    {
      mode: 'apply',
      limit: 10,
      expectedPageHash: dry.pageHash,
      expectedTotalSourceProducts: 1,
      manifestId: dry.manifestId,
    },
    harness.p,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ready, false);
  assert.equal(result.applied, 0);
  assert.equal(result.failures[0]?.reason, 'offer-set-mismatch');
  assert.equal(harness.updatedOffers.length, 0);
  assert.equal(harness.observations.length, 0);
});

test('apply fails closed when ownership changes inside an offer or observation write', async () => {
  const offerTakeover = port();
  const offerDry = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, offerTakeover.p);
  assert.equal(offerDry.ok, true);
  if (!offerDry.ok) return;
  offerTakeover.p.upsertOffer = async () => false;
  assert.deepEqual(
    await replayAlibabaRawPage(
      {
        mode: 'apply',
        limit: 10,
        expectedPageHash: offerDry.pageHash,
        expectedTotalSourceProducts: 1,
        manifestId: offerDry.manifestId,
      },
      offerTakeover.p,
    ),
    { ok: false, reason: 'lease-lost' },
  );
  assert.equal(offerTakeover.observations.length, 0);

  const observationTakeover = port();
  const observationDry = await replayAlibabaRawPage(
    { mode: 'dry-run', limit: 10 },
    observationTakeover.p,
  );
  assert.equal(observationDry.ok, true);
  if (!observationDry.ok) return;
  observationTakeover.p.upsertObservation = async () => false;
  assert.deepEqual(
    await replayAlibabaRawPage(
      {
        mode: 'apply',
        limit: 10,
        expectedPageHash: observationDry.pageHash,
        expectedTotalSourceProducts: 1,
        manifestId: observationDry.manifestId,
      },
      observationTakeover.p,
    ),
    { ok: false, reason: 'lease-lost' },
  );
});

test('apply binds every page to the authoritative active source total', async () => {
  const harness = port();
  const dry = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, harness.p);
  assert.equal(dry.ok, true);
  if (!dry.ok) return;
  harness.p.listSourceProducts = async () => ({ items: [fixture().source], total: 2 });
  assert.deepEqual(
    await replayAlibabaRawPage(
      {
        mode: 'apply',
        limit: 10,
        expectedPageHash: dry.pageHash,
        expectedTotalSourceProducts: 1,
        manifestId: dry.manifestId,
      },
      harness.p,
    ),
    { ok: false, reason: 'page-changed' },
  );
});

test('raw byte-size and run provenance mismatches fail closed before writes', async () => {
  const sizeMismatch = fixture();
  sizeMismatch.payload.byteLength = Number(sizeMismatch.payload.byteLength) + 1;
  const sizeHarness = port(sizeMismatch);
  const sizeResult = await replayAlibabaRawPage({ mode: 'dry-run', limit: 10 }, sizeHarness.p);
  assert.equal(sizeResult.ok, true);
  if (!sizeResult.ok) return;
  assert.equal(sizeResult.ready, false);
  assert.equal(sizeResult.failures[0]?.reason, 'raw-size-mismatch');
  assert.equal(sizeHarness.updatedOffers.length, 0);
  assert.equal(sizeHarness.observations.length, 0);

  const missingProvenance = fixture();
  missingProvenance.source.firstSeenRunId = undefined;
  const provenanceHarness = port(missingProvenance);
  const provenanceResult = await replayAlibabaRawPage(
    { mode: 'dry-run', limit: 10 },
    provenanceHarness.p,
  );
  assert.equal(provenanceResult.ok, true);
  if (!provenanceResult.ok) return;
  assert.equal(provenanceResult.ready, false);
  assert.equal(provenanceResult.failures[0]?.reason, 'invalid-source-row');
  assert.equal(provenanceHarness.updatedOffers.length, 0);
  assert.equal(provenanceHarness.observations.length, 0);
});
