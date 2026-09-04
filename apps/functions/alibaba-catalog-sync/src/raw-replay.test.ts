import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { alibabaOfferKey, alibabaSourceKey } from '@vibelingan-channel/alibaba-catalog-sync';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { type AlibabaRawReplayPort, replayAlibabaRawPage } from './raw-replay.ts';

const NOW = '2026-09-04T08:00:00.000Z';

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
    updateOffer: async (id, patch) => {
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
  assert.deepEqual(harness.updatedOffers[0]?.patch, { sourceAttributes: { Color: 'Blue' } });
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
  offerTakeover.p.updateOffer = async () => false;
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
