/** Map already-parsed Dianxiaomi candidates onto the transport-neutral seam. */
import { createHash } from 'node:crypto';
import type {
  CandidateCategory,
  CandidateMedia,
  CatalogImportBundle,
  CatalogProductCandidate,
  DescriptionProvenance,
  Money,
} from '../../contracts.ts';
import { normalizeDescription } from '../../descriptions.ts';
import { type StoreListingRecord, pickCanonicalValue, pickDescription } from '../../grouping.ts';
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
  /** Import job that owns the exact private workbook object. */
  evidenceId?: string;
  observedAt: string;
}

const hashKey = (...segments: string[]): string =>
  createHash('sha256').update(segments.join('\0')).digest('hex');

function fixedPrice(money: Money): CatalogSourcePricing {
  return { mode: 'fixed', currency: money.currency, amountMinor: money.amountMinor };
}

function scopedAttributes(
  listings: readonly StoreListingRecord[],
  sourceProductKey: string,
  findings: CatalogObservationFinding[],
): Record<string, string | number | boolean> {
  const values = new Map<string, Map<string, string | number | boolean>>();
  for (const listing of listings) {
    for (const [name, value] of Object.entries(listing.attributes)) {
      const candidates = values.get(name) ?? new Map<string, string | number | boolean>();
      candidates.set(JSON.stringify(value), value);
      values.set(name, candidates);
    }
  }
  const attributes: Record<string, string | number | boolean> = {};
  for (const [name, candidates] of values) {
    if (candidates.size > 1) {
      findings.push({
        severity: 'error',
        code: 'conflicting-store-attribute',
        message: `One store-scoped source product contains conflicting values for ${JSON.stringify(name)}.`,
        sourcePath: sourceProductKey,
      });
      continue;
    }
    const value = candidates.values().next().value;
    if (value !== undefined) attributes[name] = value;
  }
  return attributes;
}

function scopedCategory(
  listings: readonly StoreListingRecord[],
  sourceProductKey: string,
  findings: CatalogObservationFinding[],
): CandidateCategory | undefined {
  const categories = new Map<string, CandidateCategory>();
  for (const listing of listings) {
    if (listing.category !== undefined) {
      categories.set(JSON.stringify(listing.category), listing.category);
    }
  }
  if (categories.size > 1) {
    findings.push({
      severity: 'error',
      code: 'conflicting-store-category',
      message: 'One store-scoped source product contains conflicting category facts.',
      sourcePath: sourceProductKey,
    });
    return undefined;
  }
  return categories.values().next().value;
}

function scopedProductMedia(listings: readonly StoreListingRecord[]): CandidateMedia[] {
  const urls: string[] = [];
  for (const listing of listings) {
    for (const url of listing.productMedia) if (!urls.includes(url)) urls.push(url);
  }
  return urls.map((sourceUrl, position) => ({
    sourceUrl,
    role: position === 0 ? ('primary' as const) : ('gallery' as const),
    position,
  }));
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
  scope?: { sourceProductKey: string; storeKey: string; listings: StoreListingRecord[] },
): { observation?: CatalogSourceObservation; findings: CatalogObservationFinding[] } {
  const findings: CatalogObservationFinding[] = [];
  const sourceProductKey = scope?.sourceProductKey ?? candidate.identity.sourceProductKey;
  const selectedDescription = scope
    ? pickDescription(
        scope.listings.map((listing) => ({
          text: listing.descriptionText,
          html: listing.descriptionHtml,
          source: listing.descriptionSource,
          sanitized: listing.descriptionSanitized === true,
        })),
      )
    : {
        text: candidate.descriptionText,
        html: candidate.descriptionHtml,
        source: candidate.descriptionSource,
        sanitized: candidate.descriptionSanitized === true,
      };
  const rawDescription = selectedDescription.html ?? selectedDescription.text;
  const description = normalizeDescription(rawDescription);
  const descriptionWasSanitized = selectedDescription.sanitized || description.sanitized;
  if (descriptionWasSanitized) {
    findings.push({
      severity: 'warning',
      code: 'description-sanitized',
      message: 'Unsafe or unsupported description markup was removed.',
      sourcePath: sourceProductKey,
    });
  }

  const variants: CatalogSourceObservation['variants'] = [];
  if (scope) {
    const seenVariantKeys = new Set<string>();
    for (const listing of scope.listings) {
      if (seenVariantKeys.has(listing.sourceVariantKey)) continue;
      seenVariantKeys.add(listing.sourceVariantKey);
      const candidateVariant = candidate.variants.find(
        (variant) => variant.identity.sourceVariantKey === listing.candidateSkuKey,
      );
      if (!candidateVariant) {
        findings.push({
          severity: 'error',
          code: 'missing-candidate-variant',
          message: 'A store listing does not resolve to its grouped candidate variant.',
          sourcePath: sourceProductKey,
        });
        continue;
      }
      variants.push({
        sourceVariantKey: listing.sourceVariantKey,
        ...(listing.externalVariantId === undefined
          ? {}
          : { externalVariantId: listing.externalVariantId }),
        // Preserve this store row's original spelling. The grouped candidate
        // only supplies the cross-store identity used to find the variant.
        sku: listing.sku,
        matchHints: {
          parentSku: listing.parentSku,
          sku: listing.sku,
          ...(listing.brand === undefined ? {} : { brand: listing.brand }),
        },
        options: Object.entries(listing.optionValues)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sourceName, value]) => ({ sourceName, value })),
        inventory:
          listing.quantity === undefined
            ? []
            : [
                {
                  storeKey: listing.storeKey,
                  quantity: listing.quantity,
                  semantics: 'unknown' as const,
                  ...(listing.capturedAt === undefined ? {} : { capturedAt: listing.capturedAt }),
                },
              ],
        media:
          listing.variantMedia === undefined
            ? []
            : [
                {
                  sourceUrl: listing.variantMedia,
                  role: 'variant' as const,
                  position: 0,
                  variantSku: listing.sku,
                },
              ],
      });
    }
  } else {
    variants.push(
      ...candidate.variants.map((variant) => ({
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
      })),
    );
  }

  const offers: CatalogSourceObservation['offers'] = [];
  const storeListings =
    scope?.listings ??
    (input.storeListings ?? []).filter(
      (listing) => listing.candidateGroupKey === candidate.identity.sourceProductKey,
    );
  if (storeListings.length > 0) {
    for (const listing of storeListings) {
      if (listing.sourceRegularPrice !== undefined) {
        offers.push({
          sourceOfferKey: hashKey(listing.sourceVariantKey, 'regular'),
          sourceVariantKey: scope ? listing.sourceVariantKey : listing.candidateSkuKey,
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
          sourceVariantKey: scope ? listing.sourceVariantKey : listing.candidateSkuKey,
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

  const externalProductIds = [
    ...new Set(
      (scope?.listings ?? [])
        .map((listing) => listing.externalProductId)
        .filter((value): value is string => value !== undefined),
    ),
  ];
  if (externalProductIds.length > 1) {
    findings.push({
      severity: 'error',
      code: 'conflicting-external-product-id',
      message: 'One store-scoped source product contains conflicting marketplace product ids.',
      sourcePath: sourceProductKey,
    });
  }
  const externalProductId = scope ? externalProductIds[0] : candidate.identity.externalProductId;
  const scopedStatuses = new Set(
    (scope?.listings ?? []).map((listing) => listing.sourceListingStatus),
  );
  const scopedStatus = scopedStatuses.has('published')
    ? 'published'
    : scopedStatuses.has('draft')
      ? 'draft'
      : scopedStatuses.has('missing')
        ? 'missing'
        : 'unknown';
  const title = scope
    ? (pickCanonicalValue(scope.listings.map((listing) => listing.title)) ?? candidate.parentSku)
    : candidate.title;
  const brand = scope
    ? pickCanonicalValue(scope.listings.map((listing) => listing.brand))
    : candidate.brand;
  const attributes = scope
    ? scopedAttributes(scope.listings, sourceProductKey, findings)
    : candidate.attributes;
  const category = scope
    ? scopedCategory(scope.listings, sourceProductKey, findings)
    : candidate.category;
  const productMedia = scope ? scopedProductMedia(scope.listings) : candidate.media;

  const observationCandidate = {
    schemaVersion: CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
    source: {
      provider: 'dianxiaomi' as const,
      sourceProductKey,
      ...(externalProductId === undefined ? {} : { externalProductId }),
      ...(scope === undefined ? {} : { storeKey: scope.storeKey }),
      observedAt: input.observedAt,
      captureMode: 'import' as const,
      completeness: scope === undefined ? ('full-product' as const) : ('partial-product' as const),
    },
    identity: {
      title,
      ...(brand === undefined ? {} : { brand }),
      matchHints: {
        parentSku: candidate.parentSku,
        ...(brand === undefined ? {} : { brand }),
      },
      ...(category === undefined ? {} : { category }),
      attributes: Object.entries(attributes)
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
              sanitized: descriptionWasSanitized,
              provenance: descriptionProvenance(selectedDescription.source),
            },
          }),
      media: productMedia,
    },
    lifecycle: {
      sourceListingStatus: scope === undefined ? candidate.sourceListingStatus : scopedStatus,
    },
    variants,
    offers,
    evidence: [
      {
        kind: 'source-file' as const,
        evidenceId: input.evidenceId ?? `dianxiaomi:${input.bundle.sourceFileSha256}`,
        sha256: input.bundle.sourceFileSha256,
        sourcePath: `products.${sourceProductKey}`,
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
          sourcePath: sourceProductKey,
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
      const candidateListings = (input.storeListings ?? []).filter(
        (listing) => listing.candidateGroupKey === candidate.identity.sourceProductKey,
      );
      const scopes = new Map<
        string,
        { sourceProductKey: string; storeKey: string; listings: StoreListingRecord[] }
      >();
      for (const listing of candidateListings) {
        const current = scopes.get(listing.sourceProductKey);
        if (current) current.listings.push(listing);
        else {
          scopes.set(listing.sourceProductKey, {
            sourceProductKey: listing.sourceProductKey,
            storeKey: listing.storeKey,
            listings: [listing],
          });
        }
      }
      const candidateScopes = scopes.size > 0 ? [...scopes.values()] : [undefined];
      for (const scope of candidateScopes) {
        const mapped = mapCandidate(candidate, input, scope);
        findings.push(...mapped.findings);
        if (mapped.observation !== undefined) observations.push(mapped.observation);
      }
    }
    return {
      schemaVersion: CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
      provider: 'dianxiaomi',
      observations,
      findings,
    };
  },
};
