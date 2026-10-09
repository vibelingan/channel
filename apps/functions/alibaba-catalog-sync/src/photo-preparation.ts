/**
 * Alibaba photos copied ahead into our storage, so drafts are ready to work on
 * and publishing never waits on photos (PT-G, owner 2026-10-09).
 *
 * - Eligible: an Alibaba-linked draft that is not archived, not published and
 *   never approved — checked again inside the save, so an approval or publish
 *   made meanwhile wins. Live and approved products never change on their own
 *   (DEC-18); their supplier photos go through Supplier changes (DEC-19).
 * - Per part (gallery: first 9 sources; description: first 18) the sync owns
 *   the field while it was never set, or while it still equals what the sync
 *   filled (`alibabaAutoPhotos`). Then it follows Alibaba. Anything else —
 *   including a list an admin emptied — is the admin's.
 * - Configuration (SKU) photos are copied too, without touching the product,
 *   so approval finds them already in our storage.
 * - A photo is copied once: an existing copy is reused. A photo that cannot be
 *   copied is left out, remembered for a day, then tried again; it never
 *   blocks the draft. A part where nothing could be copied keeps what it had.
 * - The draft changes in one optimistic save (expected revision, image locks).
 *   An admin edit made meanwhile wins; the next pass looks again.
 * - A new draft hidden while its photos are prepared (`alibabaPhotosPending`)
 *   is shown by the same save, or as soon as nothing is left to prepare.
 */
import { randomUUID } from 'node:crypto';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import {
  acquireImageMutation,
  alibabaLinkRevision,
  get,
  list,
  releaseImageMutation,
  saveCatalogProductWithIdentities,
  upsertDocWithId,
} from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT,
  PRODUCT_IMAGE_MAX_COUNT,
  alibabaPhotoSources,
  allAlibabaPhotoSources,
} from '@vibelingan-channel/shared';
import { type MediaImportResult, importCandidateImage } from './media-import.ts';

const PARTS = [
  {
    part: 'gallery',
    field: 'imageIds',
    source: 'alibabaSourceImageUrls',
    limit: PRODUCT_IMAGE_MAX_COUNT,
  },
  {
    part: 'description',
    field: 'descriptionImageIds',
    source: 'alibabaDescriptionImageUrls',
    limit: PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT,
  },
] as const;
type FieldPart = (typeof PARTS)[number];
type PartName = FieldPart['part'] | 'configurations';
interface AutoPart {
  sources: string[];
  imageIds: string[];
  /** Sources not copied yet; tried again once their failure note expires. */
  missing: string[];
}

export interface PhotoPreparationPart {
  part: PartName;
  /** The product field the photos fill; null for configuration photos (copy only). */
  field: FieldPart['field'] | null;
  sources: string[];
}
export interface PhotoPreparationPlan {
  parts: PhotoPreparationPart[];
  /** The draft is hidden while prepared; this save shows it. */
  showDraft: boolean;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

function autoPart(product: CollectionDoc, part: PartName): AutoPart | null {
  const auto = product.alibabaAutoPhotos;
  const value = auto && typeof auto === 'object' ? Reflect.get(auto, part) : undefined;
  if (!value || typeof value !== 'object') return null;
  const sources = strings(Reflect.get(value, 'sources'));
  const imageIds = strings(Reflect.get(value, 'imageIds')) ?? [];
  const missing = strings(Reflect.get(value, 'missing')) ?? [];
  return sources ? { sources, imageIds, missing } : null;
}

function eligible(product: CollectionDoc): boolean {
  return (
    typeof product.alibabaPrimarySourceKey === 'string' &&
    product.alibabaPrimarySourceKey !== '' &&
    product.archived !== true &&
    product.published !== true &&
    !product.catalogDetailApprovalReceipt
  );
}

/** Whether the sync still has work for this part: never filled, sources changed, or photos missing. */
function partWork(filled: AutoPart | null, sources: readonly string[]) {
  if (!filled || !sameList(filled.sources, sources)) return 'fill' as const;
  return filled.missing.length > 0 ? ('missing' as const) : null;
}

/**
 * What the sync should do on this product now, or null when nothing.
 * `configurationSources` are the product's SKU photo sources, when known.
 */
export function photoPreparationPlan(
  product: CollectionDoc,
  configurationSources?: readonly string[],
): PhotoPreparationPlan | null {
  const showDraft = product.alibabaPhotosPending === true;
  if (!eligible(product)) return showDraft ? { parts: [], showDraft } : null;
  const parts: PhotoPreparationPart[] = [];
  for (const { part, field, source, limit } of PARTS) {
    const sources = alibabaPhotoSources(product[source], limit);
    if (sources.length === 0) continue;
    const current = product[field];
    const filled = autoPart(product, part);
    const ownedBySync = filled
      ? sameList(strings(current) ?? [], filled.imageIds)
      : current === undefined;
    if (ownedBySync && partWork(filled, sources)) parts.push({ part, field, sources });
  }
  if (configurationSources && configurationSources.length > 0) {
    const filled = autoPart(product, 'configurations');
    if (partWork(filled, configurationSources))
      parts.push({ part: 'configurations', field: null, sources: [...configurationSources] });
  }
  return parts.length === 0 && !showDraft ? null : { parts, showDraft };
}

/** The product's configuration (SKU) photo sources from its stored observation. */
async function configurationPhotoSources(product: CollectionDoc): Promise<string[]> {
  const sourceKey = product.alibabaPrimarySourceKey;
  if (typeof sourceKey !== 'string' || sourceKey === '') return [];
  const row = await get(
    'catalogSourceObservations',
    sourceObservationDocumentId('alibaba', sourceKey),
  );
  const valid = validateCatalogSourceObservation(row?.observation);
  if (!valid.ok || valid.value.source.sourceProductKey !== sourceKey) return [];
  return allAlibabaPhotoSources(
    valid.value.variants.flatMap((variant) => variant.media.map((media) => media.sourceUrl)),
  );
}

export interface PhotoPreparationPage {
  afterProductId: string;
  nextProductId: string;
  done: boolean;
  visited: number;
  prepared: number;
  photosCopied: number;
  photosReused: number;
  photosFailed: number;
  /** Changed meanwhile or images busy: looked at again next pass. */
  busy: number;
  failures: { productId: string; reason: string }[];
}

export interface PhotoPreparationInput {
  afterProductId?: string;
  limit?: number;
  /** Only drafts hidden until their photos are in. */
  pendingOnly?: boolean;
  /** Soft budget for one call; a product in progress resumes next call. */
  budgetMs?: number;
  importImage?: (url: string) => Promise<MediaImportResult>;
  clock?: () => number;
  now?: () => string;
}

const COPY_CONCURRENCY = 4;

/** A photo that failed is not fetched again for this long (a resume, another draft). */
const FAILED_PHOTO_RETRY_MS = 24 * 60 * 60 * 1000;

type CopiedState = { imageId: string } | 'failed-recently' | null;

/** Our image for a supplier photo already copied, or a recent failure to copy it. */
async function copiedState(url: string, nowMs: number): Promise<CopiedState> {
  const link = await get('catalogSourceLinks', sourceMediaLinkId('alibaba', url));
  if (link?.provider !== 'alibaba' || link.sourceUrl !== url) return null;
  if (typeof link.imageId === 'string') {
    const image = await get('images', link.imageId);
    if (image?.status === 'active') return { imageId: link.imageId };
  }
  const failedAt = typeof link.failedAt === 'string' ? Date.parse(link.failedAt) : Number.NaN;
  return Number.isFinite(failedAt) && nowMs - failedAt < FAILED_PHOTO_RETRY_MS
    ? 'failed-recently'
    : null;
}

interface Budget {
  /** True once this call has downloaded something and its time is up. */
  outOfTime(): boolean;
  /** A batch tried at least one download (reusing copies does not count). */
  worked(): void;
}

/** Our image for each source, in source order (null when not copied); null when the budget ran out. */
async function copySources(
  sources: readonly string[],
  importImage: (url: string) => Promise<MediaImportResult>,
  budget: Budget,
  now: () => string,
  counts: Pick<PhotoPreparationPage, 'photosCopied' | 'photosReused' | 'photosFailed'>,
): Promise<(string | null)[] | null> {
  const ids: (string | null)[] = new Array(sources.length).fill(null);
  for (let start = 0; start < sources.length; start += COPY_CONCURRENCY) {
    if (budget.outOfTime()) return null;
    const batch = sources.slice(start, start + COPY_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (url) => {
        const state = await copiedState(url, Date.parse(now()));
        if (state === 'failed-recently')
          return { id: null, kind: 'failed' as const, downloaded: false };
        if (state) return { id: state.imageId, kind: 'reused' as const, downloaded: false };
        const imported = await importImage(url).catch(
          (): MediaImportResult => ({ ok: false, reason: 'fetch-failed' }),
        );
        if (imported.ok) return { id: imported.imageId, kind: 'copied' as const, downloaded: true };
        // Remembered, so a resume or another draft does not wait on it again.
        await upsertDocWithId('catalogSourceLinks', sourceMediaLinkId('alibaba', url), {
          kind: 'media',
          provider: 'alibaba',
          sourceUrl: url,
          failedAt: now(),
          failureReason: imported.reason,
        }).catch((error: unknown) =>
          console.error('[alibaba-catalog-sync] photo failure note not saved:', error),
        );
        return { id: null, kind: 'failed' as const, downloaded: true };
      }),
    );
    // Only a download attempt is progress: a resumed product re-reads its
    // copies quickly, then always gets to try its next new photo.
    if (results.some((result) => result.downloaded)) budget.worked();
    results.forEach((result, offset) => {
      ids[start + offset] = result.id;
      if (result.kind === 'reused') counts.photosReused += 1;
      else if (result.kind === 'copied') counts.photosCopied += 1;
      else counts.photosFailed += 1;
    });
  }
  return ids;
}

/**
 * Locks the images a save will reference, as admin saves do. An image that is
 * gone or no longer active means "try again later", never a broken reference.
 */
async function lockImages(imageIds: readonly string[], owner: string) {
  const acquired: string[] = [];
  try {
    for (const imageId of [...new Set(imageIds)].sort()) {
      const image = await get('images', imageId);
      if (image?.status !== 'active') {
        await unlockImages(acquired, owner);
        return null;
      }
      if (typeof image.uploadedByUserId !== 'string') continue;
      const result = await acquireImageMutation(imageId, owner, new Date().toISOString());
      if (result !== 'acquired') {
        await unlockImages(acquired, owner);
        return null;
      }
      acquired.push(imageId);
    }
    return acquired;
  } catch (error) {
    await unlockImages(acquired, owner);
    throw error;
  }
}

async function unlockImages(imageIds: readonly string[], owner: string) {
  for (const imageId of [...imageIds].reverse()) {
    try {
      const result = await releaseImageMutation(imageId, owner);
      if (result !== 'released')
        console.error(
          `[alibaba-catalog-sync] photo lock release returned ${result} for ${imageId}`,
        );
    } catch (error) {
      console.error(`[alibaba-catalog-sync] photo lock release failed for ${imageId}`, error);
    }
  }
}

type ProductOutcome = 'prepared' | 'unchanged' | 'busy' | 'out-of-time' | { failure: string };

async function prepareProduct(
  product: CollectionDoc,
  plan: PhotoPreparationPlan,
  importImage: (url: string) => Promise<MediaImportResult>,
  budget: Budget,
  now: () => string,
  counts: PhotoPreparationPage,
): Promise<ProductOutcome> {
  if (typeof product.updatedAt !== 'string') return { failure: 'no-revision' };
  const data: Record<string, unknown> = {};
  const marker: Record<string, unknown> = {};
  const attached: string[] = [];
  for (const part of plan.parts) {
    const aligned = await copySources(part.sources, importImage, budget, now, counts);
    if (aligned === null) return 'out-of-time';
    const copied = [...new Set(aligned.filter((id): id is string => id !== null))];
    const missing = part.sources.filter((_, index) => aligned[index] === null);
    const earlier = autoPart(product, part.part);
    if (part.field === null) {
      // Configuration photos: copied for approval; only the record changes.
      if (
        !earlier ||
        !sameList(earlier.sources, part.sources) ||
        !sameList(earlier.missing, missing)
      )
        marker[part.part] = { sources: part.sources, imageIds: [], missing };
      continue;
    }
    // Nothing copied: keep what the part had, so it is neither emptied nor
    // mistaken for an admin's choice. It is tried again later.
    if (copied.length === 0) continue;
    if (
      earlier &&
      sameList(earlier.sources, part.sources) &&
      sameList(earlier.imageIds, copied) &&
      sameList(earlier.missing, missing)
    )
      continue;
    data[part.field] = copied;
    attached.push(...copied);
    marker[part.part] = { sources: part.sources, imageIds: copied, missing };
  }
  if (Object.keys(marker).length > 0) {
    const earlier = product.alibabaAutoPhotos;
    data.alibabaAutoPhotos = {
      ...(earlier && typeof earlier === 'object' && !Array.isArray(earlier) ? earlier : {}),
      ...marker,
    };
  }
  if (plan.showDraft) data.alibabaPhotosPending = false;
  if (Object.keys(data).length === 0) return 'unchanged';
  const owner = `photos-${randomUUID()}`;
  const locked = await lockImages(attached, owner);
  if (locked === null) return 'busy';
  try {
    const result = await saveCatalogProductWithIdentities({
      mode: 'update',
      productId: product._id,
      data,
      expectedUpdatedAt: product.updatedAt,
      // Approved, published or archived meanwhile: never changed by the sync.
      requireUnapprovedDraft: true,
      expectedAlibabaIdentity: {
        revision: alibabaLinkRevision(product),
        primarySourceKey:
          typeof product.alibabaPrimarySourceKey === 'string'
            ? product.alibabaPrimarySourceKey
            : null,
      },
    });
    if (result.result === 'saved') return 'prepared';
    if (result.result === 'stale' || result.result === 'alibaba-identity-conflict') return 'busy';
    return { failure: result.result };
  } finally {
    await unlockImages(locked, owner);
  }
}

/**
 * One page of photo preparation, in product id order. Stops at a product
 * boundary when the budget runs out; that product resumes on the next call
 * (photos already copied are reused, so it costs no second download). Each
 * call copies at least one batch, so it always makes progress.
 */
export async function prepareAlibabaPhotosPage(
  input: PhotoPreparationInput = {},
): Promise<PhotoPreparationPage> {
  const afterProductId = input.afterProductId ?? '';
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 100)));
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = input.budgetMs ?? 12_000;
  let worked = false;
  const budget: Budget = {
    outOfTime: () => worked && clock() - startedAt >= budgetMs,
    worked: () => {
      worked = true;
    },
  };
  const importImage = input.importImage ?? ((url: string) => importCandidateImage(url));
  const now = input.now ?? (() => new Date().toISOString());
  const page = await list({
    collection: 'products',
    page: 1,
    pageSize: limit,
    search: '',
    sort: [{ field: '_id', dir: 'asc' }],
    filter: {
      combinator: 'and',
      clauses: [
        ...(afterProductId ? [{ field: '_id', op: 'gt' as const, value: afterProductId }] : []),
        ...(input.pendingOnly
          ? [{ field: 'alibabaPhotosPending', op: 'eq' as const, value: true }]
          : []),
      ],
    },
  });
  const result: PhotoPreparationPage = {
    afterProductId,
    nextProductId: afterProductId,
    done: false,
    visited: 0,
    prepared: 0,
    photosCopied: 0,
    photosReused: 0,
    photosFailed: 0,
    busy: 0,
    failures: [],
  };
  for (const product of page.items) {
    const plan = eligible(product)
      ? photoPreparationPlan(product, await configurationPhotoSources(product))
      : photoPreparationPlan(product);
    if (plan) {
      const outcome = await prepareProduct(product, plan, importImage, budget, now, result);
      if (outcome === 'out-of-time') return result;
      if (outcome === 'prepared') result.prepared += 1;
      else if (outcome === 'busy') result.busy += 1;
      else if (outcome !== 'unchanged')
        result.failures.push({ productId: product._id, reason: outcome.failure });
    }
    result.visited += 1;
    result.nextProductId = product._id;
    if (budget.outOfTime() && product !== page.items.at(-1)) return result;
  }
  result.done = page.items.length < limit;
  return result;
}

/** How much is left: hidden new drafts, drafts still to fill, and drafts missing some photos. */
export async function photoPreparationStatus(): Promise<{
  hiddenDrafts: number;
  draftsToFill: number;
  draftsMissingPhotos: number;
}> {
  let hiddenDrafts = 0;
  let draftsToFill = 0;
  let draftsMissingPhotos = 0;
  let after = '';
  for (;;) {
    const page = await list({
      collection: 'products',
      page: 1,
      pageSize: 100,
      search: '',
      sort: [{ field: '_id', dir: 'asc' }],
      ...(after
        ? {
            filter: {
              combinator: 'and' as const,
              clauses: [{ field: '_id', op: 'gt' as const, value: after }],
            },
          }
        : {}),
    });
    for (const product of page.items) {
      if (product.alibabaPhotosPending === true) hiddenDrafts += 1;
      const parts = photoPreparationPlan(product)?.parts ?? [];
      const work = parts.map((part) => partWork(autoPart(product, part.part), part.sources));
      if (work.includes('fill')) draftsToFill += 1;
      else if (work.includes('missing')) draftsMissingPhotos += 1;
    }
    const last = page.items.at(-1);
    if (page.items.length < 100 || !last) break;
    after = last._id;
  }
  return { hiddenDrafts, draftsToFill, draftsMissingPhotos };
}
