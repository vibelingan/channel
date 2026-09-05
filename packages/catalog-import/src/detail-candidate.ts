/**
 * UI-01: turn one explicitly bound source observation into a review candidate.
 * NOT a publication action, store-merging policy or database write. Only the
 * reviewed canonical projection may expose this DTO through a public handler.
 */
import {
  type CatalogDetailVariant,
  type CatalogProductDetail,
  decodeCatalogProductDetail,
} from '@vibelingan-channel/shared/catalog-detail';
import { validateCatalogSourceObservation } from './source-observations.ts';

export interface CatalogDetailBindings {
  productId: string;
  /** source variant key -> existing canonical variant ID, never inferred from a label */
  variants: ReadonlyMap<string, string>;
  /** source URL -> approved/local image ID, never a COS URL */
  images: ReadonlyMap<string, string>;
  categoryLabel?: string;
}

export function buildCatalogDetailCandidate(
  input: unknown,
  bindings: CatalogDetailBindings,
  page = 1,
  pageSize = 50,
) {
  const validated = validateCatalogSourceObservation(input);
  if (!validated.ok) return validated;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50 ||
    !Number.isSafeInteger((page - 1) * pageSize)
  ) {
    return { ok: false as const, errors: ['Invalid variant pagination'] };
  }
  const observation = validated.value;
  const warnings: string[] = [];
  const images = (media: typeof observation.content.media) => {
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
    if (resolved.length > 9) warnings.push('gallery-limited-to-nine');
    return resolved.slice(0, 9);
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
    return { ok: false as const, errors: ['Missing or duplicate canonical variant binding'] };
  }
  const offset = (page - 1) * pageSize;
  const variants: CatalogDetailVariant[] = observation.variants
    .slice(offset, offset + pageSize)
    .map((variant) => {
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
        offers: observation.offers
          .filter((o) => o.sourceVariantKey === variant.sourceVariantKey)
          .map(offer),
      };
    });
  const descriptionText = observation.content.description?.text?.trim();
  const candidate: CatalogProductDetail = {
    schemaVersion: 'catalog-product-detail-v1',
    _id: bindings.productId,
    name: observation.identity.title ?? '',
    ...(bindings.categoryLabel ? { categoryLabel: bindings.categoryLabel } : {}),
    ...(descriptionText ? { descriptionText } : {}),
    images: images(observation.content.media),
    facts: facts(observation.identity.attributes),
    offers: observation.offers.filter((o) => o.sourceVariantKey === undefined).map(offer),
    variants: {
      items: variants,
      page,
      pageSize,
      total: observation.variants.length,
      hasMore: offset + variants.length < observation.variants.length,
    },
  };
  const result = decodeCatalogProductDetail(candidate);
  return result.ok ? { ...result, warnings: [...new Set(warnings)] } : result;
}
