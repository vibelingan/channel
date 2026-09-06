/**
 * UI-02 isolated local rehearsal. No cloud adapter, credentials or sync trigger.
 * Source updates and explicit local approval are separate operations. The
 * process must have this workspace's adapters wired for the entire rehearsal.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildCatalogDetailCandidate } from '@vibelingan-channel/catalog-import/detail-candidate';
import {
  type CatalogSourceObservation,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import {
  backfillPublishedRefCounts,
  get,
  list,
  saveCatalogProductWithIdentities,
  setAdapter,
  updateDoc,
} from '@vibelingan-channel/db';
import {
  bindProduct,
  bindVariant,
  writeVariant,
} from '@vibelingan-channel/fn-admin/catalog-import-store';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import type { CollectionDoc, ProductFamily } from '@vibelingan-channel/shared';
import {
  CatalogDetailHeaderSchema,
  CatalogDetailPublicationSchema,
  CatalogDetailVariantSchema,
} from '@vibelingan-channel/shared/catalog-detail';
import { JsonFileAdapter } from './json-adapter.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = (observation: CatalogSourceObservation) =>
  `ui02:${hash(`${observation.source.provider}\0${observation.source.sourceProductKey}`)}`;
let localWorkspace: { adapter: JsonFileAdapter; storage: LocalDiskMediaStorage } | undefined;

function activateLocalWorkspace() {
  if (!localWorkspace) throw new Error('Wire an isolated local workspace first');
  setAdapter(localWorkspace.adapter);
  setMediaStorage(localWorkspace.storage);
}

export function wireLocalDetailWorkspace(databaseFile: string, mediaDirectory: string) {
  // No fallback to credentials/environment-selected storage, even if the host
  // also runs a connected dev server in a different process.
  const adapter = new JsonFileAdapter(databaseFile);
  localWorkspace = { adapter, storage: new LocalDiskMediaStorage(mediaDirectory) };
  activateLocalWorkspace();
  return adapter;
}

async function variantsFor(productId: string): Promise<CollectionDoc[]> {
  const rows: CollectionDoc[] = [];
  for (let page = 1; ; page++) {
    const result = await list({
      collection: 'productVariants',
      page,
      pageSize: 100,
      filter: { combinator: 'and', clauses: [{ field: 'productId', op: 'eq', value: productId }] },
      sort: [{ field: '_id', dir: 'asc' }],
    });
    rows.push(...result.items);
    if (rows.length >= result.total) return rows;
    if (result.items.length === 0) throw new Error('Incomplete local variant read');
  }
}

function requireClone(product: CollectionDoc | null): asserts product is CollectionDoc {
  if (!product || product.localDetailClone !== true) throw new Error('Not a UI-02 local clone');
}

/** One complete observation; multi-store grouping must happen BEFORE this seam. */
export async function materializeLocalDetail(input: {
  observation: unknown;
  /** Already confirmed sample family, never inferred from provider category. */
  productFamily: ProductFamily;
  images: ReadonlyMap<string, string>;
}) {
  activateLocalWorkspace();
  const parsed = validateCatalogSourceObservation(input.observation);
  if (!parsed.ok) throw new Error('Invalid source observation');
  const observation = parsed.value;
  if (observation.source.completeness !== 'full-product')
    throw new Error('Complete product required');
  const owner = scope(observation);
  const now = new Date().toISOString();
  // Validate the entire candidate before reserving persistent identities.
  const preliminary = buildCatalogDetailCandidate(observation, {
    productId: 'validation-only',
    images: input.images,
    variants: new Map(observation.variants.map((v, i) => [v.sourceVariantKey, `validation-${i}`])),
  });
  if (!preliminary.ok) throw new Error(preliminary.errors.join('; '));
  const binding = await bindProduct(
    owner,
    {
      identity: { provider: observation.source.provider, sourceProductKey: owner },
      parentSku: observation.identity.matchHints.parentSku ?? '',
      sourceListingStatus: observation.lifecycle.sourceListingStatus,
    },
    now,
  );
  const productId = binding.channelId;
  const productFields = {
    name: observation.identity.title,
    description: observation.content.description?.text ?? '',
    imageIds: preliminary.value.images.map((url) => url.slice('/api/images/'.length)),
  };
  let product = await get('products', productId);
  if (!product) {
    const saved = await saveCatalogProductWithIdentities({
      mode: 'create',
      productId,
      data: {
        name: observation.identity.title,
        productFamily: input.productFamily,
        description: observation.content.description?.text ?? '',
        imageIds: preliminary.value.images.map((url) => url.slice('/api/images/'.length)),
        detailSourceProductFields: productFields,
        localDetailClone: true,
        detailSourceOwner: owner,
        published: false,
        archived: false,
      },
    });
    if (saved.result !== 'saved') throw new Error(`Cannot create local clone: ${saved.result}`);
    product = saved.doc;
  }
  requireClone(product);
  if (product.detailSourceOwner !== owner) throw new Error('Source ownership mismatch');
  if (
    typeof product.detailSourceObservedAt === 'string' &&
    product.detailSourceObservedAt > observation.source.observedAt
  ) {
    return { productId, variants: observation.variants.length, stale: true, warnings: [] };
  }
  const bindings = new Map<string, string>();
  for (const variant of observation.variants) {
    const key = `${owner}:${hash(variant.sourceVariantKey)}`;
    const bound = await bindVariant(
      key,
      productId,
      observation.source.provider,
      variant.sku ?? '',
      now,
    );
    const existing = await get('productVariants', bound.channelId);
    if (existing && (existing.productId !== productId || existing.detailSourceOwner !== owner)) {
      throw new Error('Variant ownership mismatch');
    }
    bindings.set(variant.sourceVariantKey, bound.channelId);
  }
  const active = new Set(bindings.values());
  await updateDoc('products', productId, { detailSourceReady: false });
  const previousProductFields = product.detailSourceProductFields;
  const productPatch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(productFields)) {
    if (
      product.published !== true &&
      field === 'imageIds' &&
      typeof previousProductFields === 'object' &&
      previousProductFields !== null &&
      Object.hasOwn(previousProductFields, field) &&
      isDeepStrictEqual(product[field], Reflect.get(previousProductFields, field))
    )
      productPatch[field] = value;
  }
  await updateDoc('products', productId, {
    ...productPatch,
    // Title and description are operator-owned after creation. Only repair an
    // untouched draft gallery; a replay never changes a published gallery.
    ...(product.published !== true ? { detailSourceProductFields: productFields } : {}),
  });
  const warnings = new Set<string>();
  for (let page = 1; page <= Math.max(1, Math.ceil(observation.variants.length / 50)); page++) {
    const candidate = buildCatalogDetailCandidate(
      observation,
      { productId, images: input.images, variants: bindings },
      page,
    );
    if (!candidate.ok) throw new Error(candidate.errors.join('; '));
    for (const warning of candidate.warnings) warnings.add(warning);
    for (const [offset, variant] of candidate.value.variants.items.entries()) {
      const position = (page - 1) * 50 + offset;
      const existing = await get('productVariants', variant.id);
      const fields = {
        sku: variant.sku ?? '',
        position,
        optionValues: Object.fromEntries(variant.options.map((o) => [o.name, o.value])),
        imageIds: variant.images.map((url) => url.slice('/api/images/'.length)),
      };
      if (!existing)
        await writeVariant({ variantId: variant.id, productId, ...fields, inventory: undefined });
      // Three-way update: preserve operator edits; only move values still equal
      // to the previous source write. Approval snapshots never change here.
      const previous = existing?.detailSourceFields;
      const patch: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(fields)) {
        if (
          !existing ||
          (typeof previous === 'object' &&
            previous !== null &&
            Object.hasOwn(previous, field) &&
            isDeepStrictEqual(existing[field], Reflect.get(previous, field)))
        ) {
          patch[field] = value;
        }
      }
      await updateDoc('productVariants', variant.id, {
        ...patch,
        detailSourceOwner: owner,
        detailSourceFields: fields,
        detailSourceCandidate: variant,
        detailSourceMissing: false,
      });
    }
    if (page === 1) {
      const { variants: _variants, revision: _revision, ...header } = candidate.value;
      await updateDoc('products', productId, { detailSourceCandidate: header });
    }
  }
  for (const variant of await variantsFor(productId)) {
    if (variant.detailSourceOwner === owner && !active.has(variant._id)) {
      await updateDoc('productVariants', variant._id, { detailSourceMissing: true });
    }
  }
  await updateDoc('products', productId, {
    detailSourceObservedAt: observation.source.observedAt,
    detailSourceReady: true,
  });
  return { productId, variants: active.size, stale: false, warnings: [...warnings] };
}

/** Explicit approval of a LOCAL clone only. Never exported as a cloud action. */
export async function approveLocalDetail(productId: string) {
  activateLocalWorkspace();
  const product = await get('products', productId);
  requireClone(product);
  if (product.detailSourceReady !== true) throw new Error('Source materialization is incomplete');
  if (product.archived !== false) throw new Error('Archived clone cannot be approved');
  const source = CatalogDetailHeaderSchema.parse(product.detailSourceCandidate);
  const imageIds = Array.isArray(product.imageIds)
    ? product.imageIds.filter((v): v is string => typeof v === 'string')
    : [];
  const { descriptionText: _description, ...withoutDescription } = source;
  const header = CatalogDetailHeaderSchema.parse({
    ...withoutDescription,
    name: product.name,
    images: imageIds.map((id) => `/api/images/${id}`),
    ...(typeof product.description === 'string' && product.description.trim()
      ? { descriptionText: product.description.trim() }
      : {}),
  });
  const rows = (await variantsFor(productId)).filter(
    (row) =>
      row.detailSourceOwner === product.detailSourceOwner &&
      row.detailSourceMissing === false &&
      row.archived !== true,
  );
  rows.sort((a, b) => Number(a.position) - Number(b.position) || a._id.localeCompare(b._id));
  const approved = rows.map((row) => {
    const original = CatalogDetailVariantSchema.parse(row.detailSourceCandidate);
    const values = row.optionValues;
    const options =
      typeof values === 'object' && values !== null && !Array.isArray(values)
        ? Object.entries(values).map(([name, value]) => ({ name, value }))
        : [];
    return CatalogDetailVariantSchema.parse({
      ...original,
      sku: row.sku || undefined,
      options,
      images: Array.isArray(row.imageIds) ? row.imageIds.map((id) => `/api/images/${id}`) : [],
    });
  });
  // Refcounts are maintained by the existing product image references. Do not
  // publish a variant-only image whose ownership the old lifecycle cannot see.
  for (const variant of approved) {
    if (variant.images.some((url) => !header.images.includes(url)))
      throw new Error('Variant image must be in the approved product gallery');
  }
  for (const id of imageIds) {
    const image = await get('images', id);
    if (!image || image.status !== 'active' || image.storageProvider !== 'local-disk')
      throw new Error('Local image is not ready');
  }
  const revision = randomUUID();
  // No partially replaced snapshot can be served during this bounded rehearsal.
  await updateDoc('products', productId, { catalogDetailPublication: null });
  for (const [position, variant] of approved.entries()) {
    await updateDoc('productVariants', variant.id, {
      catalogDetailApproved: variant,
      catalogDetailRevision: revision,
      catalogDetailPosition: position,
    });
  }
  const publication = CatalogDetailPublicationSchema.parse({
    state: 'approved',
    revision,
    header,
    variantCount: approved.length,
  });
  const saved = await saveCatalogProductWithIdentities({
    mode: 'update',
    productId,
    data: { published: true, catalogDetailPublication: publication },
  });
  if (saved.result !== 'saved') throw new Error(`Local publication failed: ${saved.result}`);
  await backfillPublishedRefCounts();
  return { productId, revision, variants: approved.length };
}
