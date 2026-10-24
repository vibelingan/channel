/** Supplier review rules shared by the Admin comparison and the final database transaction. */
import { createHash } from 'node:crypto';
import {
  type CatalogSourceObservation,
  sourceMediaLinkId,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { type CollectionDoc, alibabaPhotoSource } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { catalogValidationFailure } from '@vibelingan-channel/shared/catalog-issues';
import {
  SupplierDecisionsSchema,
  type SupplierReviewPart,
  type SupplierReviewPartName,
} from '@vibelingan-channel/shared/catalog-supplier-review';
import type { ApprovalFailure } from './catalog-approval-job.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const ids = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const paths = (value: unknown) => ids(value).map((id) => `/api/images/${id}`);

/** Ties a decision to one exact incoming value: a newer value asks again. */
export function incomingDigest(part: SupplierReviewPartName, value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([part, value]))
    .digest('hex');
}

/** Parts still waiting for the admin's Keep or Use incoming. */
export function pendingSupplierParts(parts: readonly SupplierReviewPart[]) {
  return parts.filter((part) => !part.decision).map((part) => part.part);
}

/** The first N distinct supplier URLs, in the supplier's order, as an import adds them. */
const firstUrls = (urls: readonly string[], limit: number) => [...new Set(urls)].slice(0, limit);

/**
 * Where the website value came from. A recorded baseline (MIU-39) says
 * whether the part was Alibaba's at the last approval; an edit since then
 * makes it the admin's. Before baselines: the description was Alibaba's when
 * the approved version kept its layout (only kept when the texts matched).
 */
function origin(
  product: CollectionDoc,
  part: SupplierReviewPartName,
  unedited: boolean,
): SupplierReviewPart['origin'] {
  const receipt = product.catalogDetailApprovalReceipt;
  const parts =
    receipt && typeof receipt === 'object' ? Reflect.get(receipt, 'supplierParts') : undefined;
  const recorded = parts && typeof parts === 'object' ? Reflect.get(parts, part) : undefined;
  if (!unedited || recorded === false) return 'admin';
  if (recorded === true) return 'supplier';
  if (part === 'description') {
    const publication = product.catalogDetailPublication;
    const kept =
      publication &&
      typeof publication === 'object' &&
      (Reflect.get(publication, 'content') != null ||
        Reflect.get(publication, 'noteBlocks') != null);
    if (kept) return 'supplier';
  }
  return 'unknown';
}

/** The admin-owned parts whose incoming supplier value differs from the website's. */
export async function readSupplierParts(
  product: CollectionDoc,
  observation: CatalogSourceObservation,
  sourceLinkImageId: (url: string) => Promise<string | undefined>,
): Promise<SupplierReviewPart[]> {
  const publication = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  const header = publication.success ? publication.data.header : undefined;
  const decisions = SupplierDecisionsSchema.safeParse(product.supplierDecisions);
  const decided = (part: SupplierReviewPartName, digest: string) => {
    const decision = decisions.success ? decisions.data[part] : undefined;
    return decision?.incomingDigest === digest ? { decision: decision.choice } : {};
  };
  const parts: SupplierReviewPart[] = [];

  const incomingText = text(observation.content.description?.text);
  const websiteText = text(product.description);
  if (incomingText !== '' && incomingText !== websiteText) {
    const digest = incomingDigest('description', incomingText);
    parts.push({
      part: 'description',
      website: { text: websiteText },
      incoming: { text: incomingText },
      origin: origin(product, 'description', websiteText === text(header?.descriptionText)),
      incomingDigest: digest,
      ...decided('description', digest),
    });
  }

  const photoParts = [
    {
      part: 'gallery' as const,
      urls: firstUrls(
        [...observation.content.media]
          .sort((a, b) => a.position - b.position)
          .map((media) => media.sourceUrl),
        9,
      ),
      website: ids(product.imageIds),
      approved: header?.images ?? [],
    },
    {
      part: 'descriptionImages' as const,
      urls: firstUrls(observation.content.description?.imageUrls ?? [], 18),
      website: ids(product.descriptionImageIds),
      approved: header?.descriptionImages ?? [],
    },
  ];
  for (const { part, urls, website, approved } of photoParts) {
    if (urls.length === 0) continue;
    const linked = await Promise.all(
      urls.map(async (url) => (await sourceLinkImageId(url)) ?? null),
    );
    if (same(linked, website)) continue;
    const digest = incomingDigest(part, urls);
    parts.push({
      part,
      website: { imageIds: website },
      incoming: { urls, imageIds: linked },
      origin: origin(product, part, same(paths(website), approved)),
      incomingDigest: digest,
      ...decided(part, digest),
    });
  }
  return parts;
}

export function sourcePhotoLookupUrl(url: string) {
  const transport = new URL(alibabaPhotoSource(url) ?? url);
  // Keep old owned CDN bindings readable without fetching them.
  if (
    transport.protocol === 'http:' &&
    (transport.hostname === 'alicdn.com' || transport.hostname.endsWith('.alicdn.com'))
  )
    transport.protocol = 'https:';
  return transport.href;
}

/** Approval reads only existing photo bindings; it never imports or changes them. */
export async function readSupplierPhotoImageId(
  reader: Pick<CatalogApprovalTransaction, 'get'>,
  url: string,
) {
  const sourceUrl = sourcePhotoLookupUrl(url);
  const link = await reader.get('catalogSourceLinks', sourceMediaLinkId('alibaba', sourceUrl));
  return link?._id === sourceMediaLinkId('alibaba', sourceUrl) &&
    link.provider === 'alibaba' &&
    link.sourceUrl === sourceUrl &&
    typeof link.imageId === 'string'
    ? link.imageId
    : undefined;
}

/** Recheck the decisions inside the same transaction that will publish and clear the review flag. */
export async function publicationReview(
  tx: Pick<CatalogApprovalTransaction, 'get'>,
  product: CollectionDoc,
  sourceKey: string | null,
  approvedSourceDigest: string | undefined,
): Promise<{ ok: true; acknowledge: boolean } | ApprovalFailure> {
  if (product.alibabaReviewPending !== true) return { ok: true, acknowledge: false };
  const reason = product.alibabaReviewReason ?? 'new';
  if (
    reason === 'edited' &&
    (product.alibabaPrimarySourceKey == null || product.alibabaPrimarySourceKey === '')
  )
    return { ok: true, acknowledge: true };
  if (typeof reason !== 'string' || !['new', 'changed', 'removed', 'edited'].includes(reason))
    return catalogValidationFailure('commit', [
      {
        code: 'INVALID_VALUE',
        stage: 'source',
        path: 'source',
        severity: 'error',
        remedy: 'system-repair',
      },
    ]);
  if (!sourceKey || sourceKey !== product.alibabaPrimarySourceKey)
    return { ok: false, code: 'SOURCE_NOT_READY' };
  if (
    product.alibabaSourcePublicDigest != null &&
    (typeof product.alibabaSourcePublicDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(product.alibabaSourcePublicDigest) ||
      approvedSourceDigest !== product.alibabaSourcePublicDigest)
  )
    return catalogValidationFailure('commit', [
      {
        code: 'SOURCE_NOT_READY',
        stage: 'source',
        path: 'source',
        severity: 'error',
        remedy: 'resync',
      },
    ]);
  const observationId = sourceObservationDocumentId('alibaba', sourceKey);
  const row = await tx.get('catalogSourceObservations', observationId);
  const parsed = validateCatalogSourceObservation(row?.observation);
  if (
    row?._id !== observationId ||
    !parsed.ok ||
    parsed.value.source.provider !== 'alibaba' ||
    parsed.value.source.sourceProductKey !== sourceKey ||
    parsed.value.source.completeness !== 'full-product'
  )
    return catalogValidationFailure('commit', [
      {
        code: 'SOURCE_NOT_READY',
        stage: 'source',
        path: 'source',
        severity: 'error',
        remedy: 'resync',
      },
    ]);
  if (reason === 'new' || reason === 'edited') return { ok: true, acknowledge: true };
  const cache = new Map<string, Promise<string | undefined>>();
  const parts = await readSupplierParts(product, parsed.value, (url) => {
    const normalized = sourcePhotoLookupUrl(url);
    let result = cache.get(normalized);
    if (!result) {
      result = readSupplierPhotoImageId(tx, normalized);
      cache.set(normalized, result);
    }
    return result;
  });
  // A remaining differing part cannot claim "incoming" without applying that value.
  const undecided = parts.filter((part) => part.decision !== 'keep');
  if (undecided.length)
    return catalogValidationFailure(
      'commit',
      undecided.map((part) => ({
        code: 'INVALID_VALUE',
        stage: 'source',
        path:
          part.part === 'description'
            ? 'description'
            : part.part === 'gallery'
              ? 'imageIds'
              : 'descriptionImageIds',
        severity: 'error',
        remedy: 'review-change',
      })),
    );
  return { ok: true, acknowledge: true };
}
