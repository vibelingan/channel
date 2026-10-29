import { createHash } from 'node:crypto';
import {
  CatalogTaxonomySchema,
  compareBySort,
  productFamilyForDoc,
  readProductSubcategories,
} from '@vibelingan-channel/shared';
import { CatalogDetailVariantSchema } from '@vibelingan-channel/shared/catalog-detail';
import { CATALOG_DETAIL_VARIANT_MAX_COUNT } from '@vibelingan-channel/shared/catalog-detail-approval';
import {
  PUBLIC_VARIANTS_PER_PRODUCT_CAP,
  publicItem,
  publicVariant,
} from '@vibelingan-channel/shared/catalog-public-projection';
import { resolvePublicVersion } from '@vibelingan-channel/shared/catalog-public-version';
import { z } from 'zod';
import { approvedVariantTarget, canonicalApprovedVariant } from './catalog-detail-storage.ts';
import type { CatalogPublicState } from './catalog-public-changes.ts';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value.trim() === value &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }),
  );
const row = z.object({ _id: id }).passthrough();
const inputSchema = z
  .object({
    product: row,
    detailEnabled: z.boolean(),
    taxonomy: CatalogTaxonomySchema.optional(),
    variants: z
      .object({
        kind: z.enum(['approved', 'row']),
        total: z.number().int().nonnegative().max(CATALOG_DETAIL_VARIANT_MAX_COUNT),
        items: z.array(row).max(CATALOG_DETAIL_VARIANT_MAX_COUNT),
      })
      .strict()
      .optional(),
  })
  .strict();

export class CatalogPublicContentError extends Error {
  constructor(readonly code: 'INVALID_PUBLIC_CONTENT' | 'INCOMPLETE_PUBLIC_CONTENT') {
    super(code);
    this.name = 'CatalogPublicContentError';
  }
}

/**
 * Prepare from a complete, consistent read before the final write transaction.
 * The caller must bind this result to the product/variant generation it commits;
 * this pure function cannot establish database snapshot consistency by itself.
 */
export function prepareCatalogPublicState(input: unknown): CatalogPublicState {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new CatalogPublicContentError('INVALID_PUBLIC_CONTENT');
  const { product, detailEnabled, variants, taxonomy } = parsed.data;
  if (
    product.published !== true ||
    (Object.hasOwn(product, 'archived') && product.archived !== false)
  )
    return { productId: product._id, visible: false };

  const family = productFamilyForDoc(product);
  if (family && (!taxonomy || taxonomy.family !== family))
    throw new CatalogPublicContentError('INCOMPLETE_PUBLIC_CONTENT');
  let classification: unknown = null;
  if (family && taxonomy) {
    const assignment = readProductSubcategories(product, taxonomy);
    const assigned = new Set(assignment.status === 'valid' ? assignment.subcategoryIds : []);
    classification = {
      family,
      name: taxonomy.name,
      // Invalid historical assignments remain public, as they do in the API.
      valid: assignment.status === 'valid',
      children: taxonomy.children
        .filter((child) => assigned.has(child.id) && child.status === 'active')
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map(({ id, name, slug, order }) => ({ id, name, slug, order })),
    };
  }

  const version = resolvePublicVersion(product, { detailEnabled });
  if (
    !variants ||
    variants.kind !== version.kind ||
    variants.total !== variants.items.length ||
    (version.kind === 'approved' && variants.total !== version.publication.variantCount) ||
    new Set(variants.items.map((item) => item._id)).size !== variants.items.length
  )
    throw new CatalogPublicContentError('INCOMPLETE_PUBLIC_CONTENT');

  // A successful supplier poll changes this timestamp without changing buyer content.
  const { alibabaSourceLastSyncedAt: _pollTime, ...projected } = publicItem('products', product, {
    enableCatalogDetail: detailEnabled,
  }).doc;
  const variantHashes: string[] = [];
  let detail: unknown = null;
  let detailRevision: string | null = null;
  if (version.kind === 'approved') {
    const { header, content, noteBlocks, revision } = version.publication;
    detail = { header, content, noteBlocks };
    detailRevision = revision;
    const sorted = [...variants.items].sort(
      (left, right) => Number(left.catalogDetailPosition) - Number(right.catalogDetailPosition),
    );
    for (const [position, item] of sorted.entries()) {
      const value = CatalogDetailVariantSchema.safeParse(item.catalogDetailApproved);
      if (
        !value.success ||
        item.catalogDetailPosition !== position ||
        (Object.hasOwn(item, 'archived') && item.archived !== false) ||
        !canonicalApprovedVariant(approvedVariantTarget(product, value.data.id), item)
      )
        throw new CatalogPublicContentError('INCOMPLETE_PUBLIC_CONTENT');
      variantHashes.push(hash(value.data));
    }
  } else {
    const sorted = [...variants.items].sort((left, right) =>
      compareBySort(left, right, [
        { field: 'position', dir: 'asc' },
        { field: '_id', dir: 'asc' },
      ]),
    );
    for (const item of sorted) {
      if (item.productId !== product._id || item.archived === true)
        throw new CatalogPublicContentError('INCOMPLETE_PUBLIC_CONTENT');
    }
    for (const item of sorted.slice(0, PUBLIC_VARIANTS_PER_PRODUCT_CAP))
      variantHashes.push(hash(publicVariant(item)));
  }
  return {
    productId: product._id,
    visible: true,
    semanticHash: hash([
      'catalog-public-content-v1',
      projected,
      detail,
      variantHashes,
      classification,
    ]),
    detailRevision,
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 16) throw new CatalogPublicContentError('INVALID_PUBLIC_CONTENT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new CatalogPublicContentError('INVALID_PUBLIC_CONTENT');
  const fields: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const item: unknown = Reflect.get(value, key);
    if (item !== undefined) fields.push(`${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`);
  }
  return `{${fields.join(',')}}`;
}
