/** Fresh private inspection. Seal media and inputs before storing a readiness receipt. */
import { get } from '@vibelingan-channel/db';
import { IMAGE_MUTATION_STALE_MS, readImageMutationState } from '@vibelingan-channel/db/adapter';
import {
  catalogPreparationInputDigest,
  readCatalogPreparationInputs,
} from '@vibelingan-channel/db/catalog-preparation-store';
import { sourceDigest } from '@vibelingan-channel/db/catalog-source-staging';
import { type CollectionDoc, allAlibabaPhotoSources } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import {
  type CatalogIssue,
  CatalogIssueSchema,
  CatalogValidationReportSchema,
  catalogFailureIssue,
  catalogIssuesFromZod,
} from '@vibelingan-channel/shared/catalog-issues';
import { z } from 'zod';
import {
  type CatalogCandidateAccessCheck,
  checkCatalogCandidateAccess,
  readCatalogDetailPreviewCandidate,
} from './catalog-detail-preview.ts';
import {
  catalogSourcePreviewPagination,
  readCompleteAlibabaDetailPlan,
} from './catalog-detail-source.ts';
import { catalogValidationFailure } from './catalog-validation.ts';

const Request = z.object({ productId: z.string().trim().min(1).max(200) }).strict();
const Generation = z.number().int().nonnegative().safe();
const admin = (actor: CollectionDoc | null, id: string) =>
  actor?._id === id && actor.role === 'admin' && actor.status !== 'suspended';
const mediaConcurrency = 8;

function failureIssues(failure: { code: string; validation?: unknown }): CatalogIssue[] {
  const checked = CatalogValidationReportSchema.safeParse(failure.validation);
  return checked.success ? checked.data.issues : [catalogFailureIssue(failure.code)];
}

function hasUnavailableConfigurationPhoto(
  product: CollectionDoc,
  media: readonly { unboundSources: readonly string[] }[],
  failures: readonly { sourceUrl: string; unavailable: boolean }[],
): boolean {
  const auto = product.alibabaAutoPhotos;
  const part = auto && typeof auto === 'object' ? Reflect.get(auto, 'configurations') : null;
  const unusable = part && typeof part === 'object' ? Reflect.get(part, 'unusable') : null;
  const known = new Set(
    Array.isArray(unusable) ? unusable.flatMap((source) => allAlibabaPhotoSources([source])) : [],
  );
  const current = new Map(
    failures.flatMap((failure) => {
      const normalized = allAlibabaPhotoSources([failure.sourceUrl])[0];
      return normalized ? [[normalized, failure.unavailable] as const] : [];
    }),
  );
  return media.some((variant) =>
    variant.unboundSources.some((source) => {
      const normalized = allAlibabaPhotoSources([source])[0];
      return normalized === undefined || (current.get(normalized) ?? known.has(normalized));
    }),
  );
}

/** Human inspection preserves its original response shape and real-user authorization. */
export async function inspectCatalogPreparation(
  actorId: string,
  input: unknown,
  options: { now?: () => number; budgetMs?: number } = {},
) {
  const candidate = await readCatalogPreparationCandidate(
    input,
    async () =>
      admin(await get('users', actorId), actorId)
        ? { ok: true as const }
        : { ok: false as const, code: 'FORBIDDEN' as const },
    {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    },
  );
  if (!candidate.ok) return candidate;
  const { imageIds: _imageIds, sourcePhotos: _sourcePhotos, ...inspection } = candidate;
  return inspection;
}

/** Private plan and metadata candidate. It is neither a pixel receipt nor readiness authority. */
export async function readCatalogPreparationCandidate(
  input: unknown,
  checkAccess: CatalogCandidateAccessCheck,
  options: { now?: () => number; budgetMs?: number; mediaMode?: 'metadata' | 'defer' } = {},
) {
  const command = Request.safeParse(input);
  if (!command.success) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const access = await checkCatalogCandidateAccess(checkAccess);
  if (!access.ok) return access;
  const product = await get('products', command.data.productId);
  if (!product) return { ok: false as const, code: 'NOT_FOUND' as const };
  const generation = Generation.safeParse(product.catalogContentGeneration ?? 0);
  if (!generation.success)
    return catalogValidationFailure('review', [
      CatalogIssueSchema.parse({
        code: 'INVALID_VALUE',
        stage: 'commit',
        path: 'catalogContentGeneration',
        severity: 'error',
        remedy: 'system-repair',
      }),
    ]);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budget = options.budgetMs ?? 12000;
  if (!Number.isFinite(startedAt) || !Number.isFinite(budget) || budget <= 0)
    throw new Error('Invalid catalog inspection clock or budget');
  const initial = await readCatalogPreparationInputs({ get }, product);
  const inputDigest = catalogPreparationInputDigest(initial);
  const issues: CatalogIssue[] = [];
  let imageIds: string[] = [];
  let sourcePhotos: {
    sourceUrl: string;
    imageId: string | null;
    completedOperationId: string | null;
  }[] = [];
  let previewReady = false;
  let unbound = false;
  let unavailable = false;
  let sourceRevision: string | null = null;
  let failureInputs: { sourceUrl: string; unavailable: boolean }[] = [];
  if (product.catalogDetailPublication != null) {
    const publication = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
    if (!publication.success)
      issues.push(
        ...catalogIssuesFromZod(publication.error.issues, product.catalogDetailPublication, {
          stage: 'commit',
          remedy: 'system-repair',
        }),
      );
    else if (publication.data.header._id !== product._id)
      issues.push({ ...catalogFailureIssue('CONFLICT'), remedy: 'system-repair' });
  }
  if (
    issues.length === 0 &&
    typeof product.alibabaPrimarySourceKey === 'string' &&
    product.alibabaPrimarySourceKey
  ) {
    const planned = await readCompleteAlibabaDetailPlan(product._id, product);
    if (!planned.ok) issues.push(...failureIssues(planned));
    else {
      const pagination = catalogSourcePreviewPagination(planned, product);
      if (!pagination.ok) issues.push(...failureIssues(pagination));
      else {
        previewReady = true;
        imageIds = planned.approvalPlan.imageIds;
        sourcePhotos = planned.sourceMedia.configurationPhotos;
        sourceRevision = planned.packet.revision;
        const unboundSources = new Set(
          planned.packet.variantMedia.flatMap((media) => media.unboundSources),
        );
        unbound = unboundSources.size > 0;
        failureInputs = planned.sourceMedia.configurationFailures.filter((failure) =>
          unboundSources.has(failure.sourceUrl),
        );
        unavailable = hasUnavailableConfigurationPhoto(
          product,
          planned.packet.variantMedia,
          planned.sourceMedia.configurationFailures,
        );
      }
    }
  } else if (issues.length === 0) {
    const preview = await readCatalogDetailPreviewCandidate(
      { action: 'preview', productId: product._id },
      checkAccess,
    );
    if (!preview.ok) issues.push(...failureIssues(preview));
    else {
      previewReady = true;
      imageIds = [...preview.detail.images, ...(preview.detail.descriptionImages ?? [])].map(
        (url) => url.slice('/api/images/'.length),
      );
    }
  }
  if (unbound)
    issues.push({
      ...catalogFailureIssue('MEDIA_NOT_READY'),
      path: 'configurationPhotos',
      severity: unavailable ? 'error' : 'warning',
      remedy: unavailable ? 'edit' : 'retry-media',
    });
  imageIds = [...new Set(imageIds)].sort();
  const snapshots: unknown[] = [];
  let scanned = 0;
  let mediaBlocked = false;
  for (
    let offset = 0;
    options.mediaMode !== 'defer' && offset < imageIds.length;
    offset += mediaConcurrency
  ) {
    if (now() - startedAt >= budget) break;
    const ids = imageIds.slice(offset, offset + mediaConcurrency);
    const images = await Promise.all(ids.map((id) => get('images', id)));
    for (const [index, image] of images.entries()) {
      const id = ids[index];
      const lock = image ? readImageMutationState(image) : null;
      const busy =
        lock?.state === 'owned' && now() - Date.parse(lock.startedAt) < IMAGE_MUTATION_STALE_MS;
      const counterValid =
        image !== null &&
        (!Object.hasOwn(image, 'publishedRefCount') ||
          (typeof image.publishedRefCount === 'number' &&
            Number.isSafeInteger(image.publishedRefCount) &&
            image.publishedRefCount >= 0));
      const healthy =
        image !== null &&
        image._id === id &&
        image.status === 'active' &&
        lock?.state === 'free' &&
        (image.storageProvider === 'cloudbase-storage' || image.storageProvider === 'local-disk') &&
        counterValid;
      if (!healthy) {
        mediaBlocked ||= !busy;
        const issue: CatalogIssue = {
          ...catalogFailureIssue(busy ? 'MEDIA_BUSY' : 'MEDIA_NOT_READY'),
          path: offset + index < 10000 ? `images.${offset + index}` : 'images',
          severity: busy ? 'warning' : 'error',
        };
        if (issues.length < 50) issues.push(issue);
        else if (!busy && issues.every((entry) => entry.severity === 'warning')) issues[49] = issue;
      }
      // Shared counts and temporary lock owners do not change the image content.
      snapshots.push([
        id,
        image?._id,
        image?.status,
        image?.storageProvider,
        counterValid,
        image?.storageFileId,
        image?.storagePath,
      ]);
      scanned++;
    }
  }
  const current = await get('products', product._id);
  const currentDigest = current
    ? catalogPreparationInputDigest(await readCatalogPreparationInputs({ get }, current))
    : null;
  const finalAccess = await checkCatalogCandidateAccess(checkAccess);
  if (!finalAccess.ok) return finalAccess;
  if (currentDigest !== inputDigest) return { ok: false as const, code: 'CONFLICT' as const };
  const outcome =
    mediaBlocked || issues.some((issue) => issue.severity === 'error')
      ? ('blocked' as const)
      : !previewReady || scanned !== imageIds.length
        ? ('incomplete' as const)
        : issues.length
          ? ('preparing' as const)
          : ('ready' as const);
  return {
    ok: true as const,
    kind: 'unsealed-inspection' as const,
    productId: product._id,
    inputDigest,
    contentGeneration: generation.data,
    checkedAt: new Date(startedAt).toISOString(),
    outcome,
    previewReady,
    mediaInputDigest: sourceDigest([sourceRevision, snapshots, failureInputs]),
    media: { scanned, total: imageIds.length },
    imageIds,
    sourcePhotos,
    issues: issues.slice(0, 50),
  };
}
