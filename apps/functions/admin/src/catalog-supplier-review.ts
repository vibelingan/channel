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
import {
  type CatalogSourceObservation,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { get } from '@vibelingan-channel/db';
import { type CollectionDoc, allAlibabaPhotoSources } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import {
  ConfigurationPhotosSchema,
  SupplierDecisionsSchema,
  type SupplierReview,
} from '@vibelingan-channel/shared/catalog-supplier-review';
import { z } from 'zod';
import { type ChangeAuditReader, compareWithApproved } from './catalog-change-audit.ts';
import { sourceLinkImageId, sourceVariantIds } from './catalog-detail-source.ts';

const RequestSchema = z
  .object({ action: z.literal('supplier-review'), productId: z.string().trim().min(1).max(200) })
  .strict();

export {
  incomingDigest,
  pendingSupplierParts,
} from '@vibelingan-channel/db/catalog-supplier-review';
import { readSupplierParts } from '@vibelingan-channel/db/catalog-supplier-review';

export function supplierParts(product: CollectionDoc, observation: CatalogSourceObservation) {
  return readSupplierParts(product, observation, sourceLinkImageId);
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

const PhotoSourcesRequestSchema = z
  .object({ action: z.literal('photo-sources'), productId: z.string().trim().min(1).max(200) })
  .strict();

/** Our active copy of a supplier photo, if any. */
async function ownedCopy(url: string): Promise<string | null> {
  const imageId = await sourceLinkImageId(url);
  if (!imageId) return null;
  const image = await get('images', imageId);
  return image?.status === 'active' ? imageId : null;
}

/**
 * Every Alibaba photo of a product, gallery and description, in Alibaba's
 * order, with our copy when we have one. Edit uses it to add photos beyond
 * the ones filled automatically (more than 18 description photos). Read-only.
 */
export async function readPhotoSources(
  actorId: string,
  input: unknown,
): Promise<
  | {
      ok: true;
      gallery: { url: string; imageId: string | null }[];
      description: { url: string; imageId: string | null }[];
    }
  | { ok: false; code: 'VALIDATION_ERROR' | 'FORBIDDEN' | 'NOT_FOUND' }
> {
  const parsed = PhotoSourcesRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_ERROR' };
  const actor = await get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended')
    return { ok: false, code: 'FORBIDDEN' };
  const product = await get('products', parsed.data.productId);
  if (!product) return { ok: false, code: 'NOT_FOUND' };
  const withCopies = (value: unknown) =>
    Promise.all(
      allAlibabaPhotoSources(value).map(async (url) => ({ url, imageId: await ownedCopy(url) })),
    );
  return {
    ok: true,
    gallery: await withCopies(product.alibabaSourceImageUrls),
    description: await withCopies(product.alibabaDescriptionImageUrls),
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
