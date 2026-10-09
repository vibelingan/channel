/**
 * Alibaba photos copied ahead into our storage, so drafts are ready to work on
 * and publishing never waits on photos (PT-G, owner 2026-10-09).
 *
 * - Eligible: an Alibaba-linked draft that is not archived, not published and
 *   never approved. Live and approved products never change on their own
 *   (DEC-18); their supplier photos go through Supplier changes (DEC-19).
 * - Per part (gallery: first 9 sources; description: first 18) the sync owns
 *   the field while it is empty and was never filled, or still equals what the
 *   sync filled (`alibabaAutoPhotos`). Then it follows Alibaba. Anything else
 *   is the admin's.
 * - A photo is copied once: an existing source link is reused. A photo that
 *   cannot be copied is left out and reported; it never blocks the draft.
 * - The draft changes in one optimistic save (expected revision, image locks).
 *   An admin edit made meanwhile wins; the next pass looks again.
 * - A new draft hidden while its photos are prepared (`alibabaPhotosPending`)
 *   is shown by the same save, or as soon as nothing is left to prepare.
 */
import { randomUUID } from 'node:crypto';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
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
type PartName = (typeof PARTS)[number]['part'];
type PartField = (typeof PARTS)[number]['field'];
interface AutoPart {
  sources: string[];
  imageIds: string[];
}

export interface PhotoPreparationPart {
  part: PartName;
  field: PartField;
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
  const imageIds = strings(Reflect.get(value, 'imageIds'));
  return sources && imageIds ? { sources, imageIds } : null;
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

/** What the sync should fill on this product now, or null when nothing. */
export function photoPreparationPlan(product: CollectionDoc): PhotoPreparationPlan | null {
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
      : current === undefined || (Array.isArray(current) && current.length === 0);
    if (!ownedBySync || (filled && sameList(filled.sources, sources))) continue;
    parts.push({ part, field, sources });
  }
  return parts.length === 0 && !showDraft ? null : { parts, showDraft };
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

/** Copy (or reuse) every source; null when the budget ran out first. */
async function copySources(
  sources: readonly string[],
  importImage: (url: string) => Promise<MediaImportResult>,
  outOfTime: () => boolean,
  now: () => string,
  counts: Pick<PhotoPreparationPage, 'photosCopied' | 'photosReused' | 'photosFailed'>,
): Promise<string[] | null> {
  const ids: (string | null)[] = new Array(sources.length).fill(null);
  for (let start = 0; start < sources.length; start += COPY_CONCURRENCY) {
    if (outOfTime()) return null;
    const batch = sources.slice(start, start + COPY_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (url) => {
        const state = await copiedState(url, Date.parse(now()));
        if (state === 'failed-recently') return { id: null, kind: 'failed' as const };
        if (state) return { id: state.imageId, kind: 'reused' as const };
        const imported = await importImage(url).catch(
          (): MediaImportResult => ({ ok: false, reason: 'fetch-failed' }),
        );
        if (imported.ok) return { id: imported.imageId, kind: 'copied' as const };
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
        return { id: null, kind: 'failed' as const };
      }),
    );
    results.forEach((result, offset) => {
      ids[start + offset] = result.id;
      if (result.kind === 'reused') counts.photosReused += 1;
      else if (result.kind === 'copied') counts.photosCopied += 1;
      else counts.photosFailed += 1;
    });
  }
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/** Locks the imported images a save will reference, as admin saves do. */
async function lockImages(imageIds: readonly string[], owner: string) {
  const acquired: string[] = [];
  for (const imageId of [...new Set(imageIds)].sort()) {
    const image = await get('images', imageId);
    if (!image || typeof image.uploadedByUserId !== 'string') continue;
    const result =
      image.status === 'active'
        ? await acquireImageMutation(imageId, owner, new Date().toISOString())
        : 'busy';
    if (result !== 'acquired') {
      await unlockImages(acquired, owner);
      return null;
    }
    acquired.push(imageId);
  }
  return acquired;
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

type ProductOutcome = 'prepared' | 'busy' | 'out-of-time' | { failure: string };

async function prepareProduct(
  product: CollectionDoc,
  plan: PhotoPreparationPlan,
  importImage: (url: string) => Promise<MediaImportResult>,
  outOfTime: () => boolean,
  now: () => string,
  counts: PhotoPreparationPage,
): Promise<ProductOutcome> {
  const data: Record<string, unknown> = {};
  const filled: Record<string, AutoPart> = {};
  for (const part of plan.parts) {
    const ids = await copySources(part.sources, importImage, outOfTime, now, counts);
    if (ids === null) return 'out-of-time';
    if (ids.length > 0) data[part.field] = ids;
    filled[part.part] = { sources: part.sources, imageIds: ids };
  }
  if (plan.parts.length > 0) {
    const earlier = product.alibabaAutoPhotos;
    data.alibabaAutoPhotos = {
      ...(earlier && typeof earlier === 'object' && !Array.isArray(earlier) ? earlier : {}),
      ...filled,
    };
  }
  if (plan.showDraft) data.alibabaPhotosPending = false;
  const owner = `photos-${randomUUID()}`;
  const locked = await lockImages(
    plan.parts.flatMap((part) => (data[part.field] as string[] | undefined) ?? []),
    owner,
  );
  if (locked === null) return 'busy';
  try {
    const result = await saveCatalogProductWithIdentities({
      mode: 'update',
      productId: product._id,
      data,
      ...(typeof product.updatedAt === 'string' ? { expectedUpdatedAt: product.updatedAt } : {}),
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
 * (photos already copied are reused, so it costs no second download).
 */
export async function prepareAlibabaPhotosPage(
  input: PhotoPreparationInput = {},
): Promise<PhotoPreparationPage> {
  const afterProductId = input.afterProductId ?? '';
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 100)));
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = input.budgetMs ?? 12_000;
  const outOfTime = () => clock() - startedAt >= budgetMs;
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
    const plan = photoPreparationPlan(product);
    if (plan) {
      const outcome = await prepareProduct(product, plan, importImage, outOfTime, now, result);
      if (outcome === 'out-of-time') return result;
      if (outcome === 'prepared') result.prepared += 1;
      else if (outcome === 'busy') result.busy += 1;
      else result.failures.push({ productId: product._id, reason: outcome.failure });
    }
    result.visited += 1;
    result.nextProductId = product._id;
    if (outOfTime() && product !== page.items.at(-1)) return result;
  }
  result.done = page.items.length < limit;
  return result;
}

/** How much is left: hidden new drafts, and drafts whose photos are still to fill. */
export async function photoPreparationStatus(): Promise<{
  hiddenDrafts: number;
  draftsToFill: number;
}> {
  let hiddenDrafts = 0;
  let draftsToFill = 0;
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
      if ((photoPreparationPlan(product)?.parts.length ?? 0) > 0) draftsToFill += 1;
    }
    const last = page.items.at(-1);
    if (page.items.length < 100 || !last) break;
    after = last._id;
  }
  return { hiddenDrafts, draftsToFill };
}
