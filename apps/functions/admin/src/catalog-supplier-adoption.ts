/**
 * Before approving a linked product: which of the row's description text,
 * gallery and description images may take the supplier's newer version
 * (DEC-18, MIU-39). A part may when it was the supplier's own at the last
 * approval (receipt `supplierParts`) and nobody edited it since (the row still
 * equals the approved version). An empty supplier text or photo list never
 * replaces ours. Read-only: the browser imports the photos and saves through
 * the normal update, then approves.
 */
import {
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { get } from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { z } from 'zod';
import { sourceLinkImageId } from './catalog-detail-source.ts';

const RequestSchema = z
  .object({ action: z.literal('supplier-adoption'), productId: z.string().trim().min(1).max(200) })
  .strict();

/** What to take from the supplier: the text, or photo URLs to import in order. */
export interface SupplierAdoption {
  description?: string;
  gallery?: string[];
  descriptionImages?: string[];
}

type Part = keyof SupplierAdoption;
const PartsSchema = z
  .object({ description: z.boolean(), gallery: z.boolean(), descriptionImages: z.boolean() })
  .strict();

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const ids = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const paths = (value: unknown) => ids(value).map((id) => `/api/images/${id}`);

/**
 * Approvals before MIU-39 recorded nothing. Their structured description is
 * kept only when the row text equalled the supplier's, so it marks the text as
 * the supplier's; their photos count as the admin's.
 */
function baseline(
  product: CollectionDoc,
  publication: z.infer<typeof CatalogDetailPublicationSchema>,
) {
  const receipt = product.catalogDetailApprovalReceipt;
  const recorded = PartsSchema.safeParse(
    receipt && typeof receipt === 'object' ? Reflect.get(receipt, 'supplierParts') : undefined,
  );
  if (recorded.success) return recorded.data;
  return {
    description: publication.content !== undefined || publication.noteBlocks !== undefined,
    gallery: false,
    descriptionImages: false,
  };
}

/** True when the row shows exactly our imports of these supplier photos, in order. */
async function showsExactly(rowIds: unknown, urls: readonly string[]) {
  const linked = await Promise.all(urls.map((url) => sourceLinkImageId(url)));
  return same(ids(rowIds), linked);
}

export async function planSupplierAdoption(actorId: string, input: unknown) {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const actor = await get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended')
    return { ok: false as const, code: 'FORBIDDEN' as const };
  const nothing = { ok: true as const, adoption: {} as SupplierAdoption };
  const product = await get('products', parsed.data.productId);
  const sourceKey = product?.alibabaPrimarySourceKey;
  if (!product || typeof sourceKey !== 'string' || sourceKey === '' || product.archived === true)
    return nothing;
  const publication = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  if (!publication.success || publication.data.header._id !== product._id) return nothing;
  const stored = await get(
    'catalogSourceObservations',
    sourceObservationDocumentId('alibaba', sourceKey),
  );
  const valid = validateCatalogSourceObservation(stored?.observation);
  if (
    !valid.ok ||
    valid.value.source.completeness !== 'full-product' ||
    valid.value.source.provider !== 'alibaba' ||
    valid.value.source.sourceProductKey !== sourceKey
  )
    return nothing;
  const observation = valid.value;
  const { header } = publication.data;
  const ours = baseline(product, publication.data);
  // Still the supplier's at the last approval, and unedited since.
  const open: Record<Part, boolean> = {
    description: ours.description && text(product.description) === text(header.descriptionText),
    gallery: ours.gallery && same(paths(product.imageIds), header.images),
    descriptionImages:
      ours.descriptionImages &&
      same(paths(product.descriptionImageIds), header.descriptionImages ?? []),
  };
  const adoption: SupplierAdoption = {};
  const supplierText = text(observation.content.description?.text);
  if (open.description && supplierText !== '' && supplierText !== text(product.description))
    adoption.description = supplierText;
  // The first nine / eighteen distinct URLs, in the supplier's order, as an import adds them.
  const gallery = [
    ...new Set(
      [...observation.content.media]
        .sort((a, b) => a.position - b.position)
        .map((media) => media.sourceUrl),
    ),
  ].slice(0, 9);
  if (open.gallery && gallery.length > 0 && !(await showsExactly(product.imageIds, gallery)))
    adoption.gallery = gallery;
  const descriptionImages = [...new Set(observation.content.description?.imageUrls ?? [])].slice(
    0,
    18,
  );
  if (
    open.descriptionImages &&
    descriptionImages.length > 0 &&
    !(await showsExactly(product.descriptionImageIds, descriptionImages))
  )
    adoption.descriptionImages = descriptionImages;
  return { ok: true as const, adoption };
}
