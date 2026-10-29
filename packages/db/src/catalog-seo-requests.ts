import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectionDoc,
  isProductFamily,
  storedCatalogTaxonomy,
} from '@vibelingan-channel/shared';
import { publicItem, publicVariant } from '@vibelingan-channel/shared/catalog-public-projection';
import { resolvePublicVersion } from '@vibelingan-channel/shared/catalog-public-version';
import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value.trim() === value &&
      !Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );
const origin = z.string().refine((value) => {
  try {
    return new URL(value).protocol === 'https:' && new URL(value).origin === value;
  } catch {
    return false;
  }
});
export const CatalogSeoRecordingConfigSchema = z
  .object({ siteOrigin: origin, detailEnabled: z.boolean() })
  .strict();
export type CatalogSeoRecordingConfig = z.infer<typeof CatalogSeoRecordingConfigSchema>;
const request = z.object({
  _id: z.string().regex(/^[a-f0-9]{64}$/),
  schemaVersion: z.literal(1),
  siteOrigin: origin,
  token: z.string().uuid(),
  requestedAt: z.string().datetime(),
  state: z.enum(['pending', 'checked']),
});
export const CatalogSeoRequestSchema = z.discriminatedUnion('kind', [
  request
    .extend({ kind: z.literal('product'), productId: id, previouslyPublic: z.boolean() })
    .strict(),
  request
    .extend({
      kind: z.literal('family'),
      family: z.enum(['headphones', 'ai-gadgets', 'toys', 'misc']),
    })
    .strict(),
]);
export type CatalogSeoRequest = z.infer<typeof CatalogSeoRequestSchema>;
export interface CatalogSeoChange {
  collection: string;
  before: CollectionDoc | null;
  after: CollectionDoc | null;
}
type Store = Record<string, CollectionDoc[]>;
type Parents = {
  before(id: string): CollectionDoc | null;
  after(id: string): CollectionDoc | null;
};

export function readCatalogSeoRecordingConfig(
  env: Record<string, string | undefined>,
): CatalogSeoRecordingConfig | undefined {
  if (env.CATALOG_SEO_RECORDING === undefined || env.CATALOG_SEO_RECORDING === '0')
    return undefined;
  if (env.CATALOG_SEO_RECORDING !== '1') throw new Error('Invalid CATALOG_SEO_RECORDING');
  const config = CatalogSeoRecordingConfigSchema.parse({
    siteOrigin: env.CATALOG_SEO_SITE_ORIGIN,
    detailEnabled: env.CATALOG_DETAIL_APPROVAL_ENABLED === '1',
  });
  if (env.SITE_URL !== undefined && env.SITE_URL !== config.siteOrigin)
    throw new Error('Catalog SEO site does not match SITE_URL');
  return Object.freeze(config);
}

/** Only a request to check content. A changed approval ID alone never proves that HTML changed. */
export function catalogSeoRequests(
  changes: readonly CatalogSeoChange[],
  input: CatalogSeoRecordingConfig,
  now: string,
  parents?: Parents,
): CatalogSeoRequest[] {
  const config = CatalogSeoRecordingConfigSchema.parse(input);
  const products = new Map<string, boolean>();
  const families = new Set<string>();
  const add = (productId: string, previous: boolean) =>
    products.set(id.parse(productId), previous || products.get(productId) === true);
  for (const { collection, before, after } of changes) {
    if (isDeepStrictEqual(before, after)) continue;
    if (collection === 'products') {
      if (!isDeepStrictEqual(candidate(before, config), candidate(after, config))) {
        const target = after?._id ?? before?._id;
        if (!target || (before && after && before._id !== after._id))
          throw new Error('Catalog product identity changed');
        add(target, visible(before));
      }
    } else if (collection === 'catalogTaxonomies') {
      const family = after?._id ?? before?._id;
      if (!isProductFamily(family)) throw new Error('Invalid taxonomy identity');
      const publicRegistry = (row: CollectionDoc | null) => {
        const value = storedCatalogTaxonomy(family, row);
        return value
          ? {
              name: value.name,
              children: value.children
                .filter((child) => child.status === 'active')
                .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
            }
          : null;
      };
      if (!isDeepStrictEqual(publicRegistry(before), publicRegistry(after))) families.add(family);
    } else if (collection === 'productVariants') {
      const ids = new Set(
        [before?.productId, after?.productId].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ),
      );
      if (!parents && ids.size) throw new Error('Variant requests require the parent snapshot');
      for (const parentId of ids) {
        const previous = parents?.before(parentId) ?? null;
        const next = parents?.after(parentId) ?? null;
        if (
          !isDeepStrictEqual(
            variantContent(before, previous, config),
            variantContent(after, next, config),
          )
        )
          add(parentId, visible(previous));
      }
    }
  }
  const targets = [
    ...[...products]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([productId, previouslyPublic]) => ({
        kind: 'product' as const,
        productId,
        previouslyPublic,
      })),
    ...[...families].sort().map((family) => ({ kind: 'family' as const, family })),
  ];
  return targets.map((target) =>
    CatalogSeoRequestSchema.parse({
      ...target,
      schemaVersion: 1,
      siteOrigin: config.siteOrigin,
      state: 'pending',
      requestedAt: now,
      token: randomUUID(),
      _id: createHash('sha256')
        .update(
          JSON.stringify([
            'catalog-seo-request-v1',
            config.siteOrigin,
            target.kind,
            'productId' in target ? target.productId : target.family,
          ]),
        )
        .digest('hex'),
    }),
  );
}

/** The local adapter calls this immediately before its existing atomic file rename. */
export function catalogSeoRequestsForStore(
  before: Store,
  after: Store,
  config: CatalogSeoRecordingConfig,
  now: string,
): CatalogSeoRequest[] {
  const changes: CatalogSeoChange[] = [];
  for (const collection of ['products', 'productVariants', 'catalogTaxonomies']) {
    const previous = new Map((before[collection] ?? []).map((row) => [row._id, row]));
    const next = new Map((after[collection] ?? []).map((row) => [row._id, row]));
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
      const a = previous.get(key) ?? null;
      const b = next.get(key) ?? null;
      if (!isDeepStrictEqual(a, b)) changes.push({ collection, before: a, after: b });
    }
  }
  const previous = new Map((before.products ?? []).map((row) => [row._id, row]));
  const next = new Map((after.products ?? []).map((row) => [row._id, row]));
  return catalogSeoRequests(changes, config, now, {
    before: (key) => previous.get(key) ?? null,
    after: (key) => next.get(key) ?? null,
  });
}

function visible(product: CollectionDoc | null): boolean {
  return (
    product?.published === true &&
    (!Object.hasOwn(product, 'archived') || product.archived === false)
  );
}

function candidate(product: CollectionDoc | null, config: CatalogSeoRecordingConfig): unknown {
  if (!visible(product) || !product) return null;
  const { alibabaSourceLastSyncedAt: _pollTime, ...card } = publicItem('products', product, {
    enableCatalogDetail: config.detailEnabled,
  }).doc;
  const version = resolvePublicVersion(product, { detailEnabled: config.detailEnabled });
  const detail =
    version.kind === 'approved'
      ? {
          revision: version.publication.revision,
          header: version.publication.header,
          content: version.publication.content,
          noteBlocks: version.publication.noteBlocks,
          variantCount: version.publication.variantCount,
          variantStorage: version.publication.variantStorage,
          priceSummary: version.publication.priceSummary,
        }
      : null;
  return {
    card,
    subcategories: Array.isArray(product.subcategoryIds)
      ? [...product.subcategoryIds].sort()
      : product.subcategoryIds,
    detail,
  };
}

function variantContent(
  row: CollectionDoc | null,
  parent: CollectionDoc | null,
  config: CatalogSeoRecordingConfig,
): unknown {
  if (!row || !parent || row.productId !== parent._id || !visible(parent) || row.archived === true)
    return null;
  const version = resolvePublicVersion(parent, { detailEnabled: config.detailEnabled });
  if (version.kind === 'approved') {
    if (
      version.publication.variantStorage === 'immutable-v1' ||
      row.catalogDetailRevision !== version.publication.revision
    )
      return null;
    return {
      value: row.catalogDetailApproved,
      position: row.catalogDetailPosition,
      archived: row.archived,
    };
  }
  return { value: publicVariant(row), position: row.position };
}
