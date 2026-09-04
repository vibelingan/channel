/** Map already-parsed Dianxiaomi candidates onto the transport-neutral seam. */
import { createHash } from 'node:crypto';
import type {
  CatalogImportBundle,
  CatalogProductCandidate,
  DescriptionProvenance,
  Money,
} from '../../contracts.ts';
import { normalizeDescription } from '../../descriptions.ts';
import type { StoreListingRecord } from '../../grouping.ts';
import {
  CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
  type CatalogObservationAdapter,
  type CatalogObservationBatch,
  type CatalogObservationFinding,
  type CatalogSourceObservation,
  type CatalogSourcePricing,
  validateCatalogSourceObservation,
} from '../../source-observations.ts';

export interface DianxiaomiObservationInput {
  bundle: CatalogImportBundle;
  /** Optional richer projection from grouping; preserves each store's price. */
  storeListings?: StoreListingRecord[];
  observedAt: string;
}

const hashKey = (...segments: string[]): string =>
  createHash('sha256').update(segments.join('\0')).digest('hex');

function fixedPrice(money: Money): CatalogSourcePricing {
  return { mode: 'fixed', currency: money.currency, amountMinor: money.amountMinor };
}

const descriptionProvenance = (
  provenance: DescriptionProvenance | undefined,
): NonNullable<CatalogSourceObservation['content']['description']>['provenance'] => {
  switch (provenance) {
    case 'description':
      return 'description';
    case 'shortDescription':
      return 'short-description';
    case 'structured':
      return 'structured-fallback';
    case 'titleAndSpecs':
      return 'title-and-specs';
    case 'none':
    case undefined:
      return 'none';
  }
};

function mapCandidate(
  candidate: CatalogProductCandidate,
  input: DianxiaomiObservationInput,
): { observation?: CatalogSourceObservation; findings: CatalogObservationFinding[] } {
  const findings: CatalogObservationFinding[] = [];
  const rawDescription = candidate.descriptionHtml ?? candidate.descriptionText;
  const description = normalizeDescription(rawDescription);
  if (description.sanitized) {
    findings.push({
      severity: 'warning',
      code: 'description-sanitized',
      message: 'Unsafe or unsupported description markup was removed.',
    });
  }

  const variants = candidate.variants.map((variant) => ({
    sourceVariantKey:
      variant.identity.sourceVariantKey ??
      hashKey('dianxiaomi', candidate.identity.sourceProductKey, variant.sku),
    ...(variant.identity.externalVariantId === undefined
      ? {}
      : { externalVariantId: variant.identity.externalVariantId }),
    sku: variant.sku,
    matchHints: variant.matchHints,
    options: Object.entries(variant.optionValues)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceName, value]) => ({ sourceName, value })),
    inventory: variant.inventory,
    media: variant.media,
  }));

  const offers: CatalogSourceObservation['offers'] = [];
  const storeListings = (input.storeListings ?? []).filter(
    (listing) => listing.candidateGroupKey === candidate.identity.sourceProductKey,
  );
  if (storeListings.length > 0) {
    for (const listing of storeListings) {
      if (listing.sourceRegularPrice !== undefined) {
        offers.push({
          sourceOfferKey: hashKey(listing.sourceVariantKey, 'regular'),
          sourceVariantKey: listing.candidateSkuKey,
          ...(listing.externalVariantId === undefined
            ? {}
            : { externalVariantId: listing.externalVariantId }),
          storeKey: listing.storeKey,
          kind: 'regular',
          pricing: fixedPrice(listing.sourceRegularPrice),
        });
      }
      if (listing.sourcePromotionPrice !== undefined) {
        offers.push({
          sourceOfferKey: hashKey(listing.sourceVariantKey, 'promotion'),
          sourceVariantKey: listing.candidateSkuKey,
          ...(listing.externalVariantId === undefined
            ? {}
            : { externalVariantId: listing.externalVariantId }),
          storeKey: listing.storeKey,
          kind: 'promotion',
          pricing: fixedPrice(listing.sourcePromotionPrice),
        });
      }
    }
  } else {
    // Compatibility path for consumers that only retain CatalogImportBundle.
    for (const [index, variant] of candidate.variants.entries()) {
      const mappedVariant = variants[index];
      if (mappedVariant === undefined) continue;
      if (variant.sourceRegularPrice !== undefined) {
        offers.push({
          sourceOfferKey: hashKey(mappedVariant.sourceVariantKey, 'regular'),
          sourceVariantKey: mappedVariant.sourceVariantKey,
          ...(variant.identity.externalVariantId === undefined
            ? {}
            : { externalVariantId: variant.identity.externalVariantId }),
          kind: 'regular',
          pricing: fixedPrice(variant.sourceRegularPrice),
        });
      }
      if (variant.sourcePromotionPrice !== undefined) {
        offers.push({
          sourceOfferKey: hashKey(mappedVariant.sourceVariantKey, 'promotion'),
          sourceVariantKey: mappedVariant.sourceVariantKey,
          ...(variant.identity.externalVariantId === undefined
            ? {}
            : { externalVariantId: variant.identity.externalVariantId }),
          kind: 'promotion',
          pricing: fixedPrice(variant.sourcePromotionPrice),
        });
      }
    }
  }

  const observationCandidate = {
    schemaVersion: CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
    source: {
      provider: 'dianxiaomi' as const,
      sourceProductKey: candidate.identity.sourceProductKey,
      ...(candidate.identity.externalProductId === undefined
        ? {}
        : { externalProductId: candidate.identity.externalProductId }),
      observedAt: input.observedAt,
      captureMode: 'import' as const,
      completeness: 'full-product' as const,
    },
    identity: {
      title: candidate.title,
      ...(candidate.brand === undefined ? {} : { brand: candidate.brand }),
      matchHints: candidate.matchHints,
      ...(candidate.category === undefined ? {} : { category: candidate.category }),
      attributes: Object.entries(candidate.attributes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sourceName, value]) => ({ sourceName, value })),
    },
    content: {
      ...(rawDescription === undefined
        ? {}
        : {
            description: {
              ...(description.html === undefined ? {} : { sanitizedHtml: description.html }),
              ...(description.text === undefined ? {} : { text: description.text }),
              placeholder: description.placeholder,
              sanitized: description.sanitized,
              provenance: descriptionProvenance(candidate.descriptionSource),
            },
          }),
      media: candidate.media,
    },
    lifecycle: { sourceListingStatus: candidate.sourceListingStatus },
    variants,
    offers,
    evidence: [
      {
        kind: 'source-file' as const,
        evidenceId: input.bundle.sourceFileSha256,
        sha256: input.bundle.sourceFileSha256,
        sourcePath: `products.${candidate.identity.sourceProductKey}`,
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
      findings: [
        ...findings,
        {
          severity: 'error',
          code: 'invalid-source-observation',
          message: validated.errors.join('; '),
          sourcePath: candidate.identity.sourceProductKey,
        },
      ],
    };
  }
  return { observation: validated.value, findings };
}

export const dianxiaomiObservationAdapter: CatalogObservationAdapter<DianxiaomiObservationInput> = {
  provider: 'dianxiaomi',
  toObservations(input): CatalogObservationBatch {
    if (input.bundle.provider !== 'dianxiaomi') {
      return {
        schemaVersion: CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
        provider: 'dianxiaomi',
        observations: [],
        findings: [
          {
            severity: 'error',
            code: 'provider-mismatch',
            message: `Expected dianxiaomi bundle, received ${input.bundle.provider}.`,
          },
        ],
      };
    }

    const observations: CatalogSourceObservation[] = [];
    const findings: CatalogObservationFinding[] = [];
    for (const candidate of input.bundle.products) {
      const mapped = mapCandidate(candidate, input);
      findings.push(...mapped.findings);
      if (mapped.observation !== undefined) observations.push(mapped.observation);
    }
    return {
      schemaVersion: CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
      provider: 'dianxiaomi',
      observations,
      findings,
    };
  },
};
