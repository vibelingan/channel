/**
 * UI-02 isolated local rehearsal. No cloud adapter, credentials or sync trigger.
 * Source updates and explicit local approval are separate operations. The
 * process must have this workspace's adapters wired for the entire rehearsal.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildCompleteCatalogPreparationPlan } from '@vibelingan-channel/catalog-import/detail-candidate';
import {
  type CatalogSourceObservation,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { buildStructuredContent } from '@vibelingan-channel/catalog-import/structured-content';
import {
  backfillPublishedRefCounts,
  get,
  list,
  manageCatalogDetailApproval,
  saveCatalogProductWithIdentities,
  setAdapter,
  updateDoc,
} from '@vibelingan-channel/db';
import {
  SOURCE_LINKS,
  bindProduct,
  bindVariant,
  groupLinkId,
  writeVariant,
} from '@vibelingan-channel/fn-admin/catalog-import-store';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import type { CollectionDoc, ProductFamily } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { planCatalogDetailApproval } from '@vibelingan-channel/shared/catalog-detail-approval';
import { JsonFileAdapter } from './json-adapter.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = (observation: CatalogSourceObservation) =>
  `ui02:${hash(`${observation.source.provider}\0${observation.source.sourceProductKey}`)}`;
let localWorkspace: { adapter: JsonFileAdapter; storage: LocalDiskMediaStorage } | undefined;

function activateLocalWorkspace() {
  if (!localWorkspace) throw new Error('Wire an isolated local workspace first');
  setAdapter(localWorkspace.adapter);
  setMediaStorage(localWorkspace.storage);
  return localWorkspace;
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
  const workspace = activateLocalWorkspace();
  const parsed = validateCatalogSourceObservation(input.observation);
  if (!parsed.ok) throw new Error('Invalid source observation');
  const observation = parsed.value;
  if (observation.source.completeness !== 'full-product')
    throw new Error('Complete product required');
  const owner = scope(observation);
  const now = new Date().toISOString();
  // Read an existing clone before validating text it has already chosen to retain.
  const link = await get(SOURCE_LINKS, groupLinkId(owner));
  const previous =
    typeof link?.productId === 'string' ? await get('products', link.productId) : null;
  if (previous) {
    requireClone(previous);
    if (previous.detailSourceOwner !== owner) throw new Error('Source ownership mismatch');
  }
  const preliminary = buildCompleteCatalogPreparationPlan(observation, {
    productId: 'validation-only',
    images: input.images,
    variants: new Map(observation.variants.map((v, i) => [v.sourceVariantKey, `validation-${i}`])),
    ...(previous
      ? { websiteProduct: { ...previous, _id: 'validation-only', archived: false } }
      : {}),
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
    imageIds: preliminary.sourceHeader.images.map((url) => url.slice('/api/images/'.length)),
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
        imageIds: preliminary.sourceHeader.images.map((url) => url.slice('/api/images/'.length)),
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
  const sourceRevision = randomUUID();
  await workspace.adapter.prepareLocalDetailClone({
    action: 'begin',
    productId,
    owner,
    revision: sourceRevision,
  });
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
  const currentProduct = await get('products', productId);
  requireClone(currentProduct);
  const candidate = buildCompleteCatalogPreparationPlan(observation, {
    productId,
    images: input.images,
    variants: bindings,
    websiteProduct: { ...currentProduct, archived: false },
  });
  if (!candidate.ok) throw new Error(candidate.errors.join('; '));
  const warnings = new Set(candidate.warnings);
  for (const [position, variant] of candidate.value.variants.entries()) {
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
      detailSourceRevision: sourceRevision,
      detailSourceFields: fields,
      detailSourceCandidate: variant,
      detailSourceMissing: false,
    });
  }
  const structured =
    candidate.value.header.descriptionText === candidate.sourceHeader.descriptionText
      ? buildStructuredContent(observation.content.description)
      : { content: undefined, noteBlocks: undefined, warnings: [] };
  for (const warning of structured.warnings) warnings.add(warning);
  await updateDoc('products', productId, {
    detailSourceCandidate: candidate.sourceHeader,
    detailSourceRevision: sourceRevision,
    detailSourceContentCandidate: structured.content ?? null,
    detailSourceContentWarnings: structured.warnings,
    detailSourceNoteBlocksCandidate: structured.noteBlocks ?? null,
  });
  for (const variant of await variantsFor(productId)) {
    if (variant.detailSourceOwner === owner && !active.has(variant._id)) {
      await updateDoc('productVariants', variant._id, { detailSourceMissing: true });
    }
  }
  await updateDoc('products', productId, {
    detailSourceObservedAt: observation.source.observedAt,
    detailSourceManifest: { revision: sourceRevision, variantIds: [...active] },
  });
  const prepared = await get('products', productId);
  if (!prepared) throw new Error('Local clone disappeared');
  await workspace.adapter.prepareLocalDetailClone({
    action: 'seal',
    productId,
    owner,
    revision: sourceRevision,
    expectedGeneration: Number(prepared.catalogContentGeneration ?? 0),
  });
  return { productId, variants: active.size, stale: false, warnings: [...warnings] };
}

/** Explicit approval of a LOCAL clone only. Never exported as a cloud action. */
export async function approveLocalDetail(productId: string) {
  const workspace = activateLocalWorkspace();
  const product = await get('products', productId);
  requireClone(product);
  if (product.localDetailPreparationState !== 'complete')
    throw new Error('Source materialization is incomplete');
  if (product.archived !== false) throw new Error('Archived clone cannot be approved');
  if (
    typeof product.detailSourceOwner !== 'string' ||
    typeof product.detailSourceRevision !== 'string'
  )
    throw new Error('Source materialization is incomplete');
  // Operator edits invalidate readiness; revalidate the complete effective clone before approval.
  await workspace.adapter.prepareLocalDetailClone({
    action: 'seal',
    productId,
    owner: product.detailSourceOwner,
    revision: product.detailSourceRevision,
    expectedGeneration: Number(product.catalogContentGeneration ?? 0),
  });
  const current = await get('products', productId);
  requireClone(current);
  const rows = (await variantsFor(productId)).filter(
    (row) =>
      row.detailSourceOwner === current.detailSourceOwner &&
      row.detailSourceMissing === false &&
      row.archived !== true,
  );
  const plan = planCatalogDetailApproval({
    product: current,
    variants: rows,
    revision: 'local-check',
  });
  if (plan.publication.header.images.length === 0)
    throw new Error('Local publication failed: invalid-product');
  for (const id of plan.imageIds) {
    const image = await get('images', id);
    if (!image || image.status !== 'active' || image.storageProvider !== 'local-disk')
      throw new Error('Local image is not ready');
  }
  const actorId = 'ui02-local-approval-admin';
  await workspace.adapter.createDocWithId('users', actorId, {
    role: 'admin',
    username: 'Isolated local rehearsal',
    status: 'active',
  });
  const reviewed = await manageCatalogDetailApproval(actorId, { action: 'review', productId });
  if (!reviewed.ok || !('kind' in reviewed) || reviewed.kind !== 'review')
    throw new Error(`Local review failed: ${reviewed.ok ? 'unexpected-result' : reviewed.code}`);
  const operationId = randomUUID();
  const began = await manageCatalogDetailApproval(actorId, {
    action: 'begin',
    command: {
      productId,
      operationId,
      expectedDigest: reviewed.expectedDigest,
      expectedRevision: reviewed.expectedRevision,
    },
  });
  if (!began.ok || !('jobId' in began))
    throw new Error(`Local approval failed: ${began.ok ? 'unexpected-result' : began.code}`);
  for (let page = began.nextPage; page < began.pages; page++) {
    const staged = await manageCatalogDetailApproval(actorId, {
      action: 'page',
      jobId: began.jobId,
      page,
    });
    if (!staged.ok) throw new Error(`Local approval failed: ${staged.code}`);
  }
  const finished = await manageCatalogDetailApproval(actorId, {
    action: 'finish',
    jobId: began.jobId,
  });
  if (!finished.ok || !('jobId' in finished) || !finished.complete)
    throw new Error(`Local approval failed: ${finished.ok ? 'unexpected-result' : finished.code}`);
  const approved = await get('products', productId);
  requireClone(approved);
  const publication = CatalogDetailPublicationSchema.parse(approved.catalogDetailPublication);
  if (publication.revision !== finished.revision) throw new Error('Local approval changed');
  const saved = await saveCatalogProductWithIdentities({
    mode: 'update',
    productId,
    expectedUpdatedAt: typeof approved.updatedAt === 'string' ? approved.updatedAt : null,
    requireDetailApproval: true,
    data: { published: true },
  });
  if (saved.result !== 'saved') throw new Error(`Local publication failed: ${saved.result}`);
  await backfillPublishedRefCounts();
  return { productId, revision: publication.revision, variants: publication.variantCount };
}
