/**
 * Admin-only, one-product Alibaba detail inspection.
 *
 * This is deliberately an observation path, not a targeted mirror mutation:
 * it performs the real TOP product.get call, persists the exact private raw
 * response, and returns an allowlisted structural summary. Source mirror and
 * supplier-offer writes remain owned by the resumable sync runner so a probe
 * cannot interfere with full-run lastSeenRunId/tombstone semantics.
 */
import { randomUUID } from 'node:crypto';
import {
  type AlibabaClient,
  extractProductDetail,
  normalizeProductDetail,
  parseAlibabaApiResponse,
} from '@vibelingan-channel/alibaba-catalog-sync';
import {
  ALIBABA_SYNC_LEASE_TTL_MS,
  acquireAlibabaSyncLease,
  releaseAlibabaSyncLease,
} from '@vibelingan-channel/db';
import { storeRawPayload } from './ingest.ts';
import { PRIMARY_CONNECTION_ID } from './oauth.ts';

const DETAIL_METHOD = 'alibaba.icbu.product.get';
const PRODUCT_LANGUAGE = 'ENGLISH';
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** One validation rule shared by the HTTP boundary and the provider caller. */
export function isAlibabaProductId(value: string): boolean {
  return PRODUCT_ID_PATTERN.test(value.trim());
}

export interface ProductDetailInspectionDeps {
  client: AlibabaClient;
  getAccessToken: () => Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }>;
  now: () => string;
}

export interface ProductDetailStructuralSummary {
  sourceProductId: string;
  payloadId: string;
  deduplicated: boolean;
  rawByteLength: number;
  hasSubject: boolean;
  hasCategory: boolean;
  hasMoq: boolean;
  description: {
    kind: 'empty' | 'html' | 'text';
    characterCount: number;
  };
  imageCount: number;
  skuCount: number;
  skusWithAttributes: number;
  attributeNameCount: number;
  attributeNames: string[];
  productTierCount: number;
  skuTieredPriceCount: number;
  normalizedOfferCount: number;
  normalizedPriceModes: string[];
  currency?: string;
  sourceStatus?: string;
}

export type ProductDetailInspectionResult =
  | { ok: true; summary: ProductDetailStructuralSummary }
  | {
      ok: false;
      reason:
        | 'invalid-product-id'
        | 'lease-busy'
        | 'lease-corrupt'
        | 'not-connected'
        | 'provider-unavailable'
        | 'raw-write-failed'
        | 'malformed-response'
        | 'provider-api-error'
        | 'missing-product-id'
        | 'product-id-mismatch';
      payloadId?: string;
    };

function descriptionShape(description: string | undefined): {
  kind: 'empty' | 'html' | 'text';
  characterCount: number;
} {
  if (!description) return { kind: 'empty', characterCount: 0 };
  return {
    kind: /<\s*\/?\s*[A-Za-z][^>]*>/.test(description) ? 'html' : 'text',
    characterCount: description.length,
  };
}

export async function inspectAlibabaProductDetail(input: {
  sourceProductId: string;
  deps: ProductDetailInspectionDeps;
}): Promise<ProductDetailInspectionResult> {
  const sourceProductId = input.sourceProductId.trim();
  if (!isAlibabaProductId(sourceProductId)) {
    return { ok: false, reason: 'invalid-product-id' };
  }

  const { deps } = input;
  const holder = `inspect-${randomUUID()}`;
  const grant = await acquireAlibabaSyncLease(
    PRIMARY_CONNECTION_ID,
    holder,
    deps.now(),
    ALIBABA_SYNC_LEASE_TTL_MS,
  );
  if (grant.result === 'busy') return { ok: false, reason: 'lease-busy' };
  if (grant.result === 'corrupt') return { ok: false, reason: 'lease-corrupt' };

  try {
    // Token refresh stays single-flight with ordinary sync runs by resolving
    // only after this action owns the same per-connection lease.
    const access = await deps.getAccessToken();
    if (!access.ok) return { ok: false, reason: 'not-connected' };

    const params = { product_id: sourceProductId, language: PRODUCT_LANGUAGE };
    const response = await deps.client.callApi({
      apiPath: DETAIL_METHOD,
      protocol: 'top',
      params,
      accessToken: access.accessToken,
      timeoutMs: 5_000,
      maxAttempts: 1,
    });
    if (!response.ok) return { ok: false, reason: 'provider-unavailable' };

    const raw = await storeRawPayload({
      bodyText: response.bodyText,
      endpointId: 'product.get',
      requestFingerprint: deps.client.fingerprintFor({ apiPath: DETAIL_METHOD, params }),
      connectionId: PRIMARY_CONNECTION_ID,
      runId: `inspection-${deps.now().replace(/[:.]/g, '-')}`,
      now: deps.now(),
    });
    if (!raw.ok) return { ok: false, reason: 'raw-write-failed' };

    const envelope = parseAlibabaApiResponse(response.bodyText);
    if (envelope.kind === 'malformed') {
      return { ok: false, reason: 'malformed-response', payloadId: raw.payloadId };
    }
    if (envelope.kind === 'api-error') {
      return { ok: false, reason: 'provider-api-error', payloadId: raw.payloadId };
    }

    const detail = extractProductDetail(envelope.root);
    if (!detail.sourceProductId) {
      return { ok: false, reason: 'missing-product-id', payloadId: raw.payloadId };
    }
    if (detail.sourceProductId !== sourceProductId) {
      return { ok: false, reason: 'product-id-mismatch', payloadId: raw.payloadId };
    }

    const normalized = normalizeProductDetail({
      connectionId: PRIMARY_CONNECTION_ID,
      detail,
      payloadId: raw.payloadId,
      now: deps.now(),
    });
    if (!normalized.ok) {
      return { ok: false, reason: 'missing-product-id', payloadId: raw.payloadId };
    }

    const attributeNames = [
      ...new Set(detail.skus.flatMap((sku) => Object.keys(sku.attributes))),
    ].sort((left, right) => left.localeCompare(right));
    const normalizedPriceModes = [
      ...new Set(normalized.offers.map((offer) => offer.pricing.mode)),
    ].sort();
    const summary: ProductDetailStructuralSummary = {
      sourceProductId,
      payloadId: raw.payloadId,
      deduplicated: raw.deduplicated,
      rawByteLength: Buffer.byteLength(response.bodyText, 'utf8'),
      hasSubject: Boolean(detail.subject),
      hasCategory: Boolean(detail.categoryId || detail.categoryPath?.length),
      hasMoq: Boolean(detail.moqLexeme),
      description: descriptionShape(detail.description),
      imageCount: detail.imageUrls.length,
      skuCount: detail.skus.length,
      skusWithAttributes: detail.skus.filter((sku) => Object.keys(sku.attributes).length > 0)
        .length,
      attributeNameCount: attributeNames.length,
      attributeNames: attributeNames.slice(0, 24),
      productTierCount: detail.ladderPrices.length,
      skuTieredPriceCount: detail.skus.filter((sku) => (sku.ladderPrices?.length ?? 0) > 0).length,
      normalizedOfferCount: normalized.offers.length,
      normalizedPriceModes,
      ...(detail.currencyLexeme ? { currency: detail.currencyLexeme } : {}),
      ...(detail.status ? { sourceStatus: detail.status } : {}),
    };
    return { ok: true, summary };
  } finally {
    await releaseAlibabaSyncLease(PRIMARY_CONNECTION_ID, holder, grant.fence, deps.now());
  }
}
