/**
 * What changed at Alibaba, for the admin's side-by-side review (DEC-19,
 * DEC-20). Read-only.
 *
 * - The website's own description, gallery and description photos against the
 *   supplier's current ones: listed only when they differ and something is
 *   incoming, with where the website value came from and whether the admin
 *   already decided for exactly this incoming value.
 * - Prices, configurations and specifications, which approval takes from
 *   Alibaba as they are: old → new against the approved version.
 * - Each configuration with its supplier photos and the admin's choice.
 */
import { createHash } from 'node:crypto';
import {
  type CatalogSourceObservation,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { get } from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import {
  ConfigurationPhotosSchema,
  SupplierDecisionsSchema,
  type SupplierReview,
  type SupplierReviewPart,
  type SupplierReviewPartName,
} from '@vibelingan-channel/shared/catalog-supplier-review';
import { z } from 'zod';
import { type ChangeAuditReader, compareWithApproved } from './catalog-change-audit.ts';
import { sourceLinkImageId, sourceVariantIds } from './catalog-detail-source.ts';

const RequestSchema = z
  .object({ action: z.literal('supplier-review'), productId: z.string().trim().min(1).max(200) })
  .strict();

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
export async function supplierParts(
  product: CollectionDoc,
  observation: CatalogSourceObservation,
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

/**
 * An admin's own edit to a website part that matched Alibaba's is the admin's
 * choice: it is recorded as "keep" for Alibaba's current value, so the Changed
 * flag does not wait on a decision nobody was asked for (DEC-19).
 */
export async function withAdminEditsKept(
  product: CollectionDoc,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    !['description', 'imageIds', 'descriptionImageIds'].some((field) =>
      Object.hasOwn(values, field),
    )
  )
    return values;
  const sourceKey = product.alibabaPrimarySourceKey;
  if (typeof sourceKey !== 'string' || sourceKey === '') return values;
  const observation = await storedObservation(sourceKey);
  if (!observation) return values;
  const listed = new Set((await supplierParts(product, observation)).map((part) => part.part));
  const edited = (await supplierParts({ ...product, ...values }, observation)).filter(
    (part) => !listed.has(part.part) && !part.decision,
  );
  if (edited.length === 0) return values;
  const earlier = SupplierDecisionsSchema.safeParse(
    values.supplierDecisions ?? product.supplierDecisions ?? {},
  );
  return {
    ...values,
    supplierDecisions: {
      ...(earlier.success ? earlier.data : {}),
      ...Object.fromEntries(
        edited.map((part) => [part.part, { choice: 'keep', incomingDigest: part.incomingDigest }]),
      ),
    },
  };
}

/** The stored observation of a linked product, or null. */
export async function storedObservation(sourceKey: string) {
  const row = await get(
    'catalogSourceObservations',
    sourceObservationDocumentId('alibaba', sourceKey),
  );
  const valid = validateCatalogSourceObservation(row?.observation);
  return valid.ok &&
    valid.value.source.completeness === 'full-product' &&
    valid.value.source.provider === 'alibaba' &&
    valid.value.source.sourceProductKey === sourceKey
    ? valid.value
    : null;
}

export async function readSupplierReview(
  actorId: string,
  input: unknown,
  reader: Pick<ChangeAuditReader, 'listApprovedVariants'>,
): Promise<SupplierReview | { ok: false; code: 'VALIDATION_ERROR' | 'FORBIDDEN' | 'NOT_FOUND' }> {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_ERROR' };
  const actor = await get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended')
    return { ok: false, code: 'FORBIDDEN' };
  const product = await get('products', parsed.data.productId);
  if (!product) return { ok: false, code: 'NOT_FOUND' };
  const empty: SupplierReview = { ok: true, parts: [], changes: null, configurations: [] };
  const sourceKey = product.alibabaPrimarySourceKey;
  if (typeof sourceKey !== 'string' || sourceKey === '' || product.archived === true) return empty;
  const observation = await storedObservation(sourceKey);
  if (!observation) return empty;

  const publication = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  const comparison =
    publication.success && publication.data.header._id === product._id
      ? await compareWithApproved(reader, product, sourceKey, observation, publication.data)
      : null;

  const variantIds = sourceVariantIds(product._id, sourceKey, observation);
  const chosen = ConfigurationPhotosSchema.safeParse(product.configurationPhotos ?? {});
  const configurations = await Promise.all(
    observation.variants.map(async (variant) => {
      const id = variantIds.get(variant.sourceVariantKey) ?? variant.sourceVariantKey;
      const linked = await Promise.all(
        variant.media.slice(0, 9).map((media) => sourceLinkImageId(media.sourceUrl)),
      );
      return {
        id,
        label: variant.options.map((option) => String(option.value)).join(' / ') || 'default',
        supplierImageIds:
          linked.length > 0 && linked.every((value): value is string => value !== undefined)
            ? linked
            : null,
        adminImageIds: chosen.success ? (chosen.data[id] ?? null) : null,
      };
    }),
  );

  return {
    ok: true,
    parts: await supplierParts(product, observation),
    changes: comparison && typeof comparison === 'object' ? comparison : null,
    configurations,
  };
}
