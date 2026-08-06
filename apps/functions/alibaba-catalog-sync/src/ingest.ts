/**
 * Raw-payload evidence + source normalization ingest (MIU 6).
 *
 * Ordering contract (DESIGN_CHARTER §5.2): the EXACT response bytes are
 * durable in private hash-addressed storage BEFORE any parsing,
 * normalization, or mirror write; a raw-write failure aborts the page with
 * nothing else written.
 *
 * Mirror writes are deterministic-id upserts — reruns and duplicate timer
 * deliveries converge on identical documents. Mirror rows are last-write-wins
 * by design (R1 E7 acceptance: a stale holder's mirror write can only delay
 * freshness until the next run; PRODUCT promotion is the fenced surface).
 */
import { createHash } from 'node:crypto';
import {
  type AlibabaProductDetailDraft,
  extractProductDetail,
  normalizeProductDetail,
  parseAlibabaApiResponse,
} from '@vibelingan-channel/alibaba-catalog-sync';
import { list } from '@vibelingan-channel/db';
import { mediaStorage } from '@vibelingan-channel/media-storage';
import { createDocWithId, getDoc, updateDoc, upsertDocWithId } from './repo.ts';

export interface StoreRawPayloadInput {
  bodyText: string;
  endpointId: string;
  requestFingerprint: string;
  connectionId: string;
  runId: string;
  now: string;
  contentType?: string;
}

export type StoreRawPayloadResult =
  | { ok: true; payloadId: string; responseSha256: string; deduplicated: boolean }
  | { ok: false; error: 'raw-write-failed' };

/**
 * Persist exact response bytes, hash-addressed and deduplicated: the payload
 * METADATA row id IS the response sha256, so concurrent/replayed fetches of
 * identical bytes converge on one row + one object (single-winner create).
 */
export async function storeRawPayload(input: StoreRawPayloadInput): Promise<StoreRawPayloadResult> {
  const bytes = Buffer.from(input.bodyText, 'utf8');
  const responseSha256 = createHash('sha256').update(bytes).digest('hex');
  try {
    const existing = await getDoc('alibabaSourcePayloads', responseSha256);
    if (existing) return { ok: true, payloadId: existing._id, responseSha256, deduplicated: true };
    const stored = await mediaStorage().putObject({
      namespace: 'alibaba-raw',
      logicalId: responseSha256,
      fileName: `${responseSha256}.json`,
      mimeType: input.contentType ?? 'application/json',
      content: bytes,
    });
    const created = await createDocWithId('alibabaSourcePayloads', responseSha256, {
      connectionId: input.connectionId,
      runId: input.runId,
      endpointId: input.endpointId,
      requestFingerprint: input.requestFingerprint,
      responseSha256,
      byteLength: bytes.byteLength,
      contentType: input.contentType ?? 'application/json',
      storageFileId: stored.storageFileId,
      status: 'stored',
      fetchedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return {
      ok: true,
      payloadId: responseSha256,
      responseSha256,
      deduplicated: created === 'exists',
    };
  } catch (error) {
    console.error('[alibaba-catalog-sync] raw payload write failed:', error);
    return { ok: false, error: 'raw-write-failed' };
  }
}

export interface IngestDetailInput {
  bodyText: string;
  endpointId: string;
  requestFingerprint: string;
  connectionId: string;
  runId: string;
  now: string;
  contentType?: string;
}

export type IngestDetailResult =
  | {
      ok: true;
      sourceKey: string;
      offerKeys: string[];
      deactivatedOfferKeys: string[];
      unsupportedCurrency: boolean;
    }
  | {
      ok: false;
      error: 'raw-write-failed' | 'api-error' | 'malformed-response' | 'missing-product-id';
    };

/** Raw bytes first, then parse -> normalize -> deterministic mirror upserts. */
/**
 * Stable content fingerprint of a mirrored source product and its offers,
 * excluding run/time stamps. ARCHITECTURE §12's candidate-surge guard is about
 * how many linked products CHANGED, not how many were seen — without this the
 * guard trips on every full run, since a full run sees the whole catalog.
 */
function contentFingerprint(product: Record<string, unknown>, offers: unknown[]): string {
  const stamps = new Set([
    'lastSeenRunId',
    'firstSeenRunId',
    'createdAt',
    'updatedAt',
    'tombstonedAt',
    'demotedAt',
    'contentHash',
    'lastChangedRunId',
    // WALL-CLOCK stamps the normalizer injects on every ingest. Omitting them
    // made the fingerprint differ every run, so `changed` was always true and
    // this whole mechanism was a no-op — the surge guard still counted every
    // source SEEN. The canonical() recursion filters at every depth, so this
    // also drops the copy nested inside each offer's `pricing`.
    'fetchedAt',
    'syncedAt',
  ]);
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !stamps.has(key))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return entries.map(([key, entry]) => [key, canonical(entry)]);
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical({ product, offers })))
    .digest('hex');
}

export async function ingestProductDetail(input: IngestDetailInput): Promise<IngestDetailResult> {
  const raw = await storeRawPayload(input);
  if (!raw.ok) return { ok: false, error: 'raw-write-failed' };

  const envelope = parseAlibabaApiResponse(input.bodyText);
  if (envelope.kind === 'malformed') return { ok: false, error: 'malformed-response' };
  if (envelope.kind === 'api-error') return { ok: false, error: 'api-error' };

  const detail: AlibabaProductDetailDraft = extractProductDetail(envelope.root);
  const normalized = normalizeProductDetail({
    connectionId: input.connectionId,
    detail,
    payloadId: raw.payloadId,
    now: input.now,
  });
  if (!normalized.ok) return { ok: false, error: 'missing-product-id' };

  const { sourceProduct, offers } = normalized;
  const existingProduct = await getDoc('alibabaSourceProducts', sourceProduct.sourceKey);
  const contentHash = contentFingerprint(
    sourceProduct as unknown as Record<string, unknown>,
    offers,
  );
  const changed = String(existingProduct?.contentHash ?? '') !== contentHash;
  await upsertDocWithId('alibabaSourceProducts', sourceProduct.sourceKey, {
    ...sourceProduct,
    lastSeenRunId: input.runId,
    contentHash,
    lastChangedRunId: changed
      ? input.runId
      : String(existingProduct?.lastChangedRunId ?? input.runId),
    // First-seen provenance is written once and never rewritten; tombstone
    // state clears because the product is demonstrably present again.
    ...(existingProduct ? {} : { firstSeenRunId: input.runId, createdAt: input.now }),
    tombstonedAt: '',
  });

  for (const offer of offers) {
    await upsertDocWithId('alibabaSupplierOffers', offer.offerKey, {
      ...offer,
      lastSeenRunId: input.runId,
    });
  }

  // Product-scoped offer sweep: a detail response is the COMPLETE current SKU
  // set, so mirror offers for this source product that were not in it are no
  // longer purchasable and deactivate now (full-run tombstoning of whole
  // products stays a MIU 11 concern).
  const currentKeys = new Set(offers.map((offer) => offer.offerKey));
  const deactivated: string[] = [];
  const siblings = await listOffersBySourceKey(sourceProduct.sourceKey);
  for (const sibling of siblings) {
    if (!currentKeys.has(sibling._id) && sibling.active === true) {
      await updateDoc('alibabaSupplierOffers', sibling._id, {
        active: false,
        lastSeenRunId: input.runId,
      });
      deactivated.push(sibling._id);
    }
  }

  return {
    ok: true,
    sourceKey: sourceProduct.sourceKey,
    offerKeys: offers.map((offer) => offer.offerKey),
    deactivatedOfferKeys: deactivated,
    unsupportedCurrency: normalized.unsupportedCurrency,
  };
}

async function listOffersBySourceKey(sourceKey: string) {
  // Offers per product are bounded by the source SKU count; one filtered page
  // covers it on every adapter.
  const result = await list({
    collection: 'alibabaSupplierOffers',
    page: 1,
    pageSize: 100,
    filter: { combinator: 'and', clauses: [{ field: 'sourceKey', op: 'eq', value: sourceKey }] },
  });
  return result.items;
}
