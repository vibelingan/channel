/**
 * Raw-payload evidence + source normalization ingest (MIU 6).
 *
 * Ordering contract (DESIGN_CHARTER §5.2): the EXACT response bytes are
 * durable in private hash-addressed storage BEFORE any parsing,
 * normalization, or mirror write; a raw-write failure aborts the page with
 * nothing else written.
 *
 * Mirror writes are deterministic-id, lease-fenced upserts — reruns converge on
 * identical documents, while a stale timer holder cannot commit after takeover.
 */
import { createHash } from 'node:crypto';
import {
  type AlibabaProductDetailDraft,
  alibabaObservationAdapter,
  extractProductDetail,
  normalizeProductDetail,
  parseAlibabaApiResponse,
} from '@vibelingan-channel/alibaba-catalog-sync';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { AlibabaLeaseGuard } from '@vibelingan-channel/db';
import { mediaStorage } from '@vibelingan-channel/media-storage';
import { listAllDocs } from './list-all.ts';
import {
  createDocWithId,
  getDoc,
  updateDocWithAlibabaLease,
  upsertDocWithAlibabaLease,
} from './repo.ts';

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
  /** Product id used for the product.get request; the response must echo it exactly. */
  expectedSourceProductId: string;
  endpointId: string;
  requestFingerprint: string;
  connectionId: string;
  runId: string;
  now: string;
  /** Acquisition context only; product.get itself is always a full product detail. */
  captureMode?: 'full' | 'incremental';
  /** Fresh lease guard factory; every mutable mirror write rechecks it atomically. */
  leaseGuard: () => AlibabaLeaseGuard;
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
      error:
        | 'raw-write-failed'
        | 'api-error'
        | 'malformed-response'
        | 'missing-product-id'
        | 'product-id-mismatch'
        | 'invalid-source-observation'
        | 'lease-lost';
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
    // Provenance, not content: payloadId is the sha256 of the ENTIRE raw
    // response body, so any per-response request id or server timestamp the
    // gateway includes would change it on every call — and the fingerprint
    // would be a no-op again against the real endpoint. Two different raw
    // responses can carry identical product content.
    'payloadId',
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
  if (!detail.sourceProductId) return { ok: false, error: 'missing-product-id' };
  if (detail.sourceProductId !== input.expectedSourceProductId) {
    return { ok: false, error: 'product-id-mismatch' };
  }
  const normalized = normalizeProductDetail({
    connectionId: input.connectionId,
    detail,
    payloadId: raw.payloadId,
    now: input.now,
  });
  if (!normalized.ok) return { ok: false, error: 'missing-product-id' };

  const { sourceProduct, offers } = normalized;
  const observed = alibabaObservationAdapter.toObservations({
    connectionId: input.connectionId,
    detail,
    payloadId: raw.payloadId,
    observedAt: input.now,
    captureMode: input.captureMode ?? 'incremental',
  });
  const observation = observed.observations[0];
  if (
    observation === undefined ||
    observed.findings.some((finding) => finding.severity === 'error')
  ) {
    console.error(
      '[alibaba-catalog-sync] common observation validation failed:',
      observed.findings.map((finding) => finding.code),
    );
    return { ok: false, error: 'invalid-source-observation' };
  }
  const existingProduct = await getDoc('alibabaSourceProducts', sourceProduct.sourceKey);
  const contentHash = contentFingerprint(
    sourceProduct as unknown as Record<string, unknown>,
    offers,
  );
  const changed = String(existingProduct?.contentHash ?? '') !== contentHash;
  const sourceWritten = await upsertDocWithAlibabaLease(
    'alibabaSourceProducts',
    sourceProduct.sourceKey,
    {
      ...sourceProduct,
      lastSeenRunId: input.runId,
      contentHash,
      lastChangedRunId: changed
        ? input.runId
        : String(existingProduct?.lastChangedRunId ?? input.runId),
      tombstonedAt: '',
    },
    { firstSeenRunId: input.runId },
    input.leaseGuard(),
  );
  if (!sourceWritten) return { ok: false, error: 'lease-lost' };

  for (const offer of offers) {
    const offerWritten = await upsertDocWithAlibabaLease(
      'alibabaSupplierOffers',
      offer.offerKey,
      { ...offer, lastSeenRunId: input.runId },
      {},
      input.leaseGuard(),
    );
    if (!offerWritten) return { ok: false, error: 'lease-lost' };
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
      const deactivatedOffer = await updateDocWithAlibabaLease(
        'alibabaSupplierOffers',
        sibling._id,
        { active: false, lastSeenRunId: input.runId },
        input.leaseGuard(),
      );
      if (!deactivatedOffer) return { ok: false, error: 'lease-lost' };
      deactivated.push(sibling._id);
    }
  }

  // This is a private, provider-neutral CURRENT materialized view. The raw
  // payload remains immutable evidence and canonical products remain behind
  // their explicit link/category/promotion gates.
  const observationId = sourceObservationDocumentId('alibaba', sourceProduct.sourceKey);
  const observationWritten = await upsertDocWithAlibabaLease(
    'catalogSourceObservations',
    observationId,
    {
      provider: 'alibaba',
      sourceProductKey: sourceProduct.sourceKey,
      externalProductId: sourceProduct.sourceProductId,
      schemaVersion: observation.schemaVersion,
      observedAt: observation.source.observedAt,
      ...(observation.source.sourceUpdatedAt === undefined
        ? {}
        : { sourceUpdatedAt: observation.source.sourceUpdatedAt }),
      evidenceId: raw.payloadId,
      active: true,
      observation,
      lastSeenOperationId: input.runId,
    },
    { firstSeenOperationId: input.runId },
    input.leaseGuard(),
  );
  if (!observationWritten) return { ok: false, error: 'lease-lost' };

  return {
    ok: true,
    sourceKey: sourceProduct.sourceKey,
    offerKeys: offers.map((offer) => offer.offerKey),
    deactivatedOfferKeys: deactivated,
    unsupportedCurrency: normalized.unsupportedCurrency,
  };
}

async function listOffersBySourceKey(sourceKey: string) {
  return listAllDocs('alibabaSupplierOffers', [{ field: 'sourceKey', op: 'eq', value: sourceKey }]);
}
