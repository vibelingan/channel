import { PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT } from '@vibelingan-channel/shared';
/**
 * UI-01: turn one explicitly bound source observation into a review candidate.
 * NOT a publication action, store-merging policy or database write. Only the
 * reviewed canonical projection may expose this DTO through a public handler.
 */
import {
  CatalogDetailHeaderSchema,
  type CatalogDetailVariant,
  CatalogDetailVariantSchema,
  decodeCatalogProductDetail,
} from '@vibelingan-channel/shared/catalog-detail';
import {
  CATALOG_DETAIL_VARIANT_MAX_COUNT,
  applyWebsiteDetailHeader,
  catalogVariantCapacityIssues,
} from '@vibelingan-channel/shared/catalog-detail-approval';
import {
  type CatalogIssue,
  CatalogIssueSchema,
  CatalogValidationError,
  catalogIssueMessage,
  catalogIssuesFromZod,
} from '@vibelingan-channel/shared/catalog-issues';
import { z } from 'zod';
import { validateCatalogSourceObservation } from './source-observations.ts';

const configurationSet = z.array(CatalogDetailVariantSchema).max(CATALOG_DETAIL_VARIANT_MAX_COUNT);

export interface CatalogDetailBindings {
  productId: string;
  /** source variant key -> existing canonical variant ID, never inferred from a label */
  variants: ReadonlyMap<string, string>;
  /** source URL -> approved/local image ID, never a COS URL */
  images: ReadonlyMap<string, string>;
  categoryLabel?: string;
  /** Server-provided current website fields; raw evidence is never modified. */
  websiteProduct?: unknown;
}

/** Validate and project the complete source once; callers may then page or compare it. */
export function buildCompleteCatalogPreparationPlan(
  input: unknown,
  bindings: CatalogDetailBindings,
) {
  const validated = validateCatalogSourceObservation(input);
  if (!validated.ok) return validated;
  const observation = validated.value;
  const warnings: string[] = [];
  const images = (media: typeof observation.content.media, limit = 9) => {
    const resolved: string[] = [];
    for (const item of [...media].sort((a, b) => a.position - b.position)) {
      const id = bindings.images.get(item.sourceUrl);
      if (!id) {
        warnings.push('unbound-media');
        continue;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        warnings.push('invalid-image-binding');
        continue;
      }
      const url = `/api/images/${id}`;
      if (!resolved.includes(url)) resolved.push(url);
    }
    if (resolved.length > limit)
      warnings.push(limit === 9 ? 'gallery-limited-to-nine' : 'description-media-limit');
    return resolved.slice(0, limit);
  };
  const facts = (values: typeof observation.identity.attributes) =>
    values.flatMap((item) => {
      const value = String(item.value).trim();
      return value ? [{ name: item.sourceName, value }] : [];
    });
  const offer = (item: (typeof observation.offers)[number]) => ({
    kind: item.kind,
    basis: 'source-quote' as const,
    pricing: item.pricing,
  });
  const ids = observation.variants.map((v) => bindings.variants.get(v.sourceVariantKey));
  if (
    ids.some((id) => !id || id.trim() !== id || id.length > 200) ||
    new Set(ids).size !== ids.length
  ) {
    return {
      ok: false as const,
      errors: ['Missing or duplicate canonical variant binding'],
      issues: [
        CatalogIssueSchema.parse({
          code: 'INVALID_VALUE',
          stage: 'source',
          path: 'variants',
          severity: 'error',
          remedy: 'resync',
        }),
      ],
    };
  }
  const offersByVariant = new Map<string | undefined, ReturnType<typeof offer>[]>();
  for (const item of observation.offers) {
    const bucket = offersByVariant.get(item.sourceVariantKey) ?? [];
    bucket.push(offer(item));
    offersByVariant.set(item.sourceVariantKey, bucket);
  }
  const projected: CatalogDetailVariant[] = observation.variants.map((variant) => {
    // Validated above across ALL variants, not merely the displayed page.
    const id = bindings.variants.get(variant.sourceVariantKey);
    if (!id) throw new Error('Canonical binding changed during projection');
    const known = variant.inventory.filter((v) => v.semantics !== 'unknown');
    let inventory: CatalogDetailVariant['inventory'] = { state: 'unknown' };
    if (known.length > 0 && known.length === variant.inventory.length) {
      const first = known[0];
      if (first && first.semantics !== 'unknown') {
        inventory = known.every(
          (v) => v.quantity === first.quantity && v.semantics === first.semantics,
        )
          ? {
              state: 'reported',
              quantity: first.quantity,
              semantics: first.semantics,
              basis: 'source',
            }
          : { state: 'conflict' };
      }
    }
    return {
      id,
      ...(variant.sku ? { sku: variant.sku } : {}),
      options: facts(variant.options),
      inventory,
      images: images(variant.media),
      offers: offersByVariant.get(variant.sourceVariantKey) ?? [],
    };
  });
  // Validate the complete set before any page can become a prepared source.
  const configurations = configurationSet.safeParse(projected);
  if (!configurations.success)
    return {
      ok: false as const,
      errors: configurations.error.issues.map(
        (issue) => `${['variants', 'items', ...issue.path].join('.')}: ${issue.message}`,
      ),
      issues: catalogIssuesFromZod(configurations.error.issues, projected, {
        stage: 'effective-content',
        remedy: 'resync',
        prefix: ['variants', 'items'],
      }),
    };
  const capacity = catalogVariantCapacityIssues(configurations.data);
  if (capacity.length)
    return {
      ok: false as const,
      issues: capacity,
      errors: capacity.map(
        (issue) => catalogIssueMessage(issue) ?? 'Configuration data is too large.',
      ),
    };
  const descriptionText = observation.content.description?.text?.trim();
  const sourceHeader = {
    schemaVersion: 'catalog-product-detail-v1' as const,
    _id: bindings.productId,
    name: observation.identity.title ?? '',
    ...(bindings.categoryLabel ? { categoryLabel: bindings.categoryLabel } : {}),
    ...(descriptionText ? { descriptionText } : {}),
    ...(observation.content.description?.imageUrls?.length
      ? {
          descriptionImages: images(
            observation.content.description.imageUrls.map((sourceUrl, position) => ({
              sourceUrl,
              position,
              role: 'gallery',
            })),
            PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT,
          ),
        }
      : {}),
    images: images(observation.content.media),
    facts: facts(observation.identity.attributes),
    offers: offersByVariant.get(undefined) ?? [],
  };
  try {
    const header =
      bindings.websiteProduct === undefined
        ? sourceHeader
        : applyWebsiteDetailHeader(sourceHeader, bindings.websiteProduct);
    const checkedHeader = CatalogDetailHeaderSchema.safeParse(header);
    if (!checkedHeader.success)
      return {
        ok: false as const,
        errors: checkedHeader.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        ),
        issues: sourceIssues(
          catalogIssuesFromZod(checkedHeader.error.issues, header, {
            stage: 'effective-content',
            remedy: 'edit',
          }),
        ),
      };
    return {
      ok: true as const,
      value: { header: checkedHeader.data, variants: configurations.data },
      sourceHeader,
      warnings: [...new Set(warnings)],
    };
  } catch (error) {
    if (error instanceof CatalogValidationError)
      return {
        ok: false as const,
        errors: error.issues.map((issue) => catalogIssueMessage(issue) ?? 'Invalid product data.'),
        issues: sourceIssues(error.issues),
      };
    if (!(error instanceof z.ZodError)) throw error;
    return {
      ok: false as const,
      errors: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      issues: catalogIssuesFromZod(error.issues, bindings.websiteProduct, {
        stage: 'effective-content',
        remedy: 'edit',
      }),
    };
  }
}

/** A validated page view of the same complete plan; no validation is skipped on later rows. */
export function buildCatalogPreparationPlan(
  input: unknown,
  bindings: CatalogDetailBindings,
  page = 1,
  pageSize = 50,
) {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50 ||
    !Number.isSafeInteger((page - 1) * pageSize)
  ) {
    return {
      ok: false as const,
      errors: ['Invalid variant pagination'],
      issues: [
        CatalogIssueSchema.parse({
          code: 'INVALID_VALUE',
          stage: 'effective-content',
          path: 'page',
          severity: 'error',
          remedy: 'reload',
        }),
      ],
    };
  }
  const complete = buildCompleteCatalogPreparationPlan(input, bindings);
  if (!complete.ok) return complete;
  const offset = (page - 1) * pageSize;
  const variants = complete.value.variants;
  const result = decodeCatalogProductDetail({
    ...complete.value.header,
    variants: {
      items: variants.slice(offset, offset + pageSize),
      page,
      pageSize,
      total: variants.length,
      hasMore: offset + pageSize < variants.length,
    },
  });
  return result.ok
    ? { ...result, sourceHeader: complete.sourceHeader, warnings: complete.warnings }
    : { ...result, issues: sourceIssues(result.issues) };
}

/** Public candidate shape deliberately omits the private source header. */
export function buildCatalogDetailCandidate(
  input: unknown,
  bindings: CatalogDetailBindings,
  page = 1,
  pageSize = 50,
) {
  const result = buildCatalogPreparationPlan(input, bindings, page, pageSize);
  if (!result.ok) return result;
  const { sourceHeader: _sourceHeader, ...candidate } = result;
  return candidate;
}

function sourceIssues(issues: readonly CatalogIssue[]): CatalogIssue[] {
  return issues.map((issue) =>
    issue.path === 'facts' ||
    issue.path.startsWith('facts.') ||
    issue.path === 'offers' ||
    issue.path.startsWith('offers.')
      ? { ...issue, remedy: 'resync' }
      : issue,
  );
}
