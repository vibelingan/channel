/** Convert one complete TOP product.get draft into the shared observation seam. */
import { createHash } from 'node:crypto';
import { normalizeDescription } from '@vibelingan-channel/catalog-import/content';
import {
  CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
  type CatalogObservationAdapter,
  type CatalogObservationBatch,
  type CatalogObservationFinding,
  type CatalogSourceObservation,
  type CatalogSourcePricing,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import type { AlibabaProductDetailDraft } from './alibaba-contracts.ts';
import { PRODUCT_LEVEL_SKU_SENTINEL, normalizeProductDetail } from './alibaba-normalizer.ts';
import type { AlibabaCatalogPricing } from './alibaba-pricing.ts';

export type AlibabaObservationCaptureMode = 'full' | 'incremental' | 'selected';

export interface AlibabaObservationInput {
  connectionId: string;
  detail: AlibabaProductDetailDraft;
  payloadId: string;
  observedAt: string;
  captureMode: AlibabaObservationCaptureMode;
}

/** A variant identity is deliberately separate from today's one-offer-per-SKU key. */
export function alibabaVariantKey(
  connectionId: string,
  sourceProductId: string,
  sourceSkuId: string,
): string {
  return createHash('sha256')
    .update(`alibaba\0${connectionId}\0${sourceProductId}\0${sourceSkuId}\0variant`)
    .digest('hex');
}

function commonPricing(pricing: AlibabaCatalogPricing): CatalogSourcePricing | null {
  const minimumOrderQuantity =
    pricing.sourceMoq === undefined ? {} : { minimumOrderQuantity: pricing.sourceMoq };
  switch (pricing.mode) {
    case 'fixed':
      if (pricing.currency === undefined || pricing.amountMinor === undefined) return null;
      return {
        mode: 'fixed',
        currency: pricing.currency,
        amountMinor: pricing.amountMinor,
        ...minimumOrderQuantity,
      };
    case 'range':
      if (
        pricing.currency === undefined ||
        pricing.minAmountMinor === undefined ||
        pricing.maxAmountMinor === undefined
      ) {
        return null;
      }
      return {
        mode: 'range',
        currency: pricing.currency,
        minimumAmountMinor: pricing.minAmountMinor,
        maximumAmountMinor: pricing.maxAmountMinor,
        ...minimumOrderQuantity,
      };
    case 'tiered':
      if (pricing.currency === undefined || pricing.tiers === undefined) return null;
      return {
        mode: 'tiered',
        currency: pricing.currency,
        ...minimumOrderQuantity,
        tiers: pricing.tiers.map((tier) => ({
          minimumQuantity: tier.minQuantity,
          ...(tier.maxQuantity === undefined ? {} : { maximumQuantity: tier.maxQuantity }),
          unitAmountMinor: tier.unitAmountMinor,
        })),
      };
    case 'negotiable':
      return {
        mode: 'negotiable',
        ...(pricing.currency === undefined ? {} : { currency: pricing.currency }),
        ...minimumOrderQuantity,
      };
    case 'unavailable':
      return { mode: 'unavailable', ...minimumOrderQuantity };
  }
}

function httpMedia(
  urls: readonly string[],
  findings: CatalogObservationFinding[],
): CatalogSourceObservation['content']['media'] {
  const result: CatalogSourceObservation['content']['media'] = [];
  const seen = new Set<string>();
  for (const sourceUrl of urls) {
    try {
      const parsed = new URL(sourceUrl);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || seen.has(parsed.href)) {
        if (!seen.has(parsed.href)) {
          findings.push({
            severity: 'warning',
            code: 'invalid-media-url',
            message: 'A provider media URL did not use HTTP(S) and was omitted.',
            sourcePath: 'product.main_image',
          });
        }
        continue;
      }
      seen.add(parsed.href);
      result.push({
        sourceUrl: parsed.href,
        role: result.length === 0 ? 'primary' : 'gallery',
        position: result.length,
      });
    } catch {
      findings.push({
        severity: 'warning',
        code: 'invalid-media-url',
        message: 'A malformed provider media URL was omitted.',
        sourcePath: 'product.main_image',
      });
    }
  }
  return result;
}

function listingStatus(
  value: string | undefined,
): CatalogSourceObservation['lifecycle']['sourceListingStatus'] {
  switch (value?.trim().toLowerCase()) {
    case 'approved':
    case 'published':
    case 'online':
    case 'on_sale':
      return 'published';
    case 'draft':
    case 'editing':
    case 'offline':
      return 'draft';
    case 'deleted':
    case 'removed':
      return 'missing';
    default:
      return 'unknown';
  }
}

export const alibabaObservationAdapter: CatalogObservationAdapter<AlibabaObservationInput> = {
  provider: 'alibaba',
  toObservations(input): CatalogObservationBatch {
    const normalized = normalizeProductDetail({
      connectionId: input.connectionId,
      detail: input.detail,
      payloadId: input.payloadId,
      now: input.observedAt,
    });
    if (!normalized.ok) {
      return {
        schemaVersion: CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
        provider: 'alibaba',
        observations: [],
        findings: [
          {
            severity: 'error',
            code: normalized.reason,
            message: 'The detail response has no usable Alibaba product id.',
            sourcePath: 'product.product_id',
          },
        ],
      };
    }

    const findings: CatalogObservationFinding[] = [];
    const description = normalizeDescription(input.detail.description);
    if (description.sanitized) {
      findings.push({
        severity: 'warning',
        code: 'description-sanitized',
        message: 'Unsafe or unsupported provider description markup was removed.',
        sourcePath: 'product.description',
      });
    }
    const media = httpMedia(input.detail.imageUrls, findings);
    if (normalized.unsupportedCurrency) {
      findings.push({
        severity: 'warning',
        code: 'unsupported-currency',
        message: 'The provider currency is unsupported, so pricing is unavailable.',
        sourcePath: 'product.sourcing_trade.fob_currency',
      });
    }

    const variants: CatalogSourceObservation['variants'] = [];
    const variantKeyBySku = new Map<string, string>();
    for (const offer of normalized.offers) {
      if (offer.sourceSkuId === PRODUCT_LEVEL_SKU_SENTINEL) continue;
      const sourceVariantKey = alibabaVariantKey(
        input.connectionId,
        offer.sourceProductId,
        offer.sourceSkuId,
      );
      variantKeyBySku.set(offer.sourceSkuId, sourceVariantKey);
      variants.push({
        sourceVariantKey,
        externalVariantId: offer.sourceSkuId,
        options: Object.entries(offer.sourceAttributes)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sourceName, value]) => ({ sourceName, value })),
        inventory:
          offer.sourceAvailability === undefined
            ? []
            : [{ quantity: offer.sourceAvailability, semantics: 'sellable' }],
        media: [],
      });
    }

    const offers: CatalogSourceObservation['offers'] = [];
    for (const offer of normalized.offers) {
      const sourceVariantKey = variantKeyBySku.get(offer.sourceSkuId);
      const pricing = commonPricing(offer.pricing);
      if (pricing === null) {
        findings.push({
          severity: 'error',
          code: 'invalid-provider-pricing',
          message: 'Normalized Alibaba pricing is incomplete for its declared mode.',
          sourcePath: `offers.${offer.offerKey}.pricing`,
        });
        continue;
      }
      offers.push({
        sourceOfferKey: offer.offerKey,
        ...(sourceVariantKey === undefined ? {} : { sourceVariantKey }),
        ...(offer.sourceSkuId === PRODUCT_LEVEL_SKU_SENTINEL
          ? {}
          : { externalVariantId: offer.sourceSkuId }),
        kind: 'supplier' as const,
        pricing,
      });
    }

    const sourceProduct = normalized.sourceProduct;
    const hasCategory =
      sourceProduct.sourceCategoryId !== undefined ||
      (sourceProduct.sourceCategoryPath?.length ?? 0) > 0;
    const observationCandidate = {
      schemaVersion: CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
      source: {
        provider: 'alibaba' as const,
        sourceProductKey: sourceProduct.sourceKey,
        externalProductId: sourceProduct.sourceProductId,
        accountKey: input.connectionId,
        observedAt: input.observedAt,
        ...(sourceProduct.sourceUpdatedAt === undefined
          ? {}
          : { sourceUpdatedAt: sourceProduct.sourceUpdatedAt }),
        captureMode: input.captureMode,
        completeness: 'full-product' as const,
      },
      identity: {
        ...(sourceProduct.sourceTitle === undefined ? {} : { title: sourceProduct.sourceTitle }),
        matchHints: {},
        ...(hasCategory
          ? {
              category: {
                sourceTaxonomy: 'alibaba:icbu',
                ...(sourceProduct.sourceCategoryId === undefined
                  ? {}
                  : { sourceCategoryId: sourceProduct.sourceCategoryId }),
                ...(sourceProduct.sourceCategoryPath === undefined
                  ? {}
                  : { sourceCategoryName: sourceProduct.sourceCategoryPath.join(' > ') }),
              },
            }
          : {}),
        attributes: [],
      },
      content: {
        ...(input.detail.description === undefined
          ? {}
          : {
              description: {
                ...(description.html === undefined ? {} : { sanitizedHtml: description.html }),
                ...(description.text === undefined ? {} : { text: description.text }),
                placeholder: description.placeholder,
                sanitized: description.sanitized,
                provenance: 'provider-description' as const,
              },
            }),
        media,
      },
      lifecycle: { sourceListingStatus: listingStatus(input.detail.status) },
      variants,
      offers,
      evidence: [
        {
          kind: 'raw-payload' as const,
          evidenceId: input.payloadId,
          ...(/^[0-9a-f]{64}$/.test(input.payloadId) ? { sha256: input.payloadId } : {}),
          sourcePath: 'alibaba_icbu_product_get_response.product',
        },
      ],
      warnings: findings
        .filter((finding) => finding.severity === 'warning')
        .map(({ code, message, sourcePath }) => ({
          code,
          message,
          ...(sourcePath === undefined ? {} : { sourcePath }),
        })),
    };

    const validated = validateCatalogSourceObservation(observationCandidate);
    if (!validated.ok) {
      return {
        schemaVersion: CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
        provider: 'alibaba',
        observations: [],
        findings: [
          ...findings,
          {
            severity: 'error',
            code: 'invalid-source-observation',
            message: validated.errors.join('; '),
          },
        ],
      };
    }
    return {
      schemaVersion: CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
      provider: 'alibaba',
      observations: [validated.value],
      findings,
    };
  },
};
