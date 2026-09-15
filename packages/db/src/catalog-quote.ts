import { createHash } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  CatalogDetailVariantSchema,
} from '@vibelingan-channel/shared/catalog-detail';
import { InquiryDetailSchema } from '@vibelingan-channel/shared/catalog-inquiry';
import {
  CatalogQuoteSubmissionSchema,
  quoteFieldsForDate,
  validateQuoteTarget,
} from '@vibelingan-channel/shared/catalog-quote';

export type QuoteSaveResult = { ok: true; requestId: string } | { ok: false; code: string };
export const hashQuoteValue = (value: string) => createHash('sha256').update(value).digest('hex');
export function quoteRequestIdentity(key: string) {
  const hash = hashQuoteValue(key);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function quoteFingerprint(input: { target: unknown; fields: unknown }) {
  return hashQuoteValue(JSON.stringify({ target: input.target, fields: input.fields }));
}
export function planCatalogQuote(
  input: unknown,
  product: CollectionDoc | null | undefined,
  variant: CollectionDoc | null | undefined,
  options: { notification: 'disabled-local' | 'disabled'; now: string },
) {
  const fail = (code: string) => ({ ok: false as const, code });
  const parsed = CatalogQuoteSubmissionSchema.safeParse(input);
  if (!parsed.success) return fail('validation');
  const { fields, target, idempotencyKey } = parsed.data;
  const now = new Date(options.now);
  if (!Number.isFinite(now.getTime())) return fail('validation');
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  if (!quoteFieldsForDate(today).safeParse(fields).success) return fail('validation');
  const approved = CatalogDetailPublicationSchema.safeParse(product?.catalogDetailPublication);
  if (
    !product ||
    product.published !== true ||
    (Object.hasOwn(product, 'archived') && product.archived !== false) ||
    !approved.success ||
    approved.data.header._id !== target.productId
  )
    return fail('unavailable');
  if (product._id !== target.productId || approved.data.revision !== target.revision)
    return fail('stale-context');
  const selected = CatalogDetailVariantSchema.safeParse(variant?.catalogDetailApproved);
  if (
    target.variantId &&
    (!variant ||
      variant._id !== target.variantId ||
      variant.productId !== product._id ||
      variant.catalogDetailRevision !== target.revision ||
      (Object.hasOwn(variant, 'archived') && variant.archived !== false) ||
      !selected.success ||
      selected.data.id !== variant._id)
  )
    return fail('invalid-variant');
  const failure = validateQuoteTarget(target, {
    available: true,
    productId: product._id,
    revision: approved.data.revision,
    ...(target.variantId && selected.success
      ? { variant: { id: selected.data.id, productId: product._id } }
      : {}),
  });
  if (failure) return fail(failure);
  const snapshot = {
    productName: approved.data.header.name,
    productId: product._id,
    revision: approved.data.revision,
    images: approved.data.header.images,
    productOffers: approved.data.header.offers,
    ...(approved.data.header.websitePricing
      ? { websitePricing: approved.data.header.websitePricing }
      : {}),
    ...(target.variantId && selected.success ? { variant: selected.data } : {}),
  };
  // Bound the immutable snapshot; do not truncate commercial evidence silently.
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 64 * 1024)
    return fail('context-too-large');
  const id = quoteRequestIdentity(idempotencyKey);
  const detail = InquiryDetailSchema.safeParse({
    id,
    target,
    fields,
    snapshot,
    status: 'new',
    version: 0,
    notification: options.notification,
    createdAt: options.now,
    updatedAt: options.now,
    events: [],
  });
  if (!detail.success) return fail('invalid-context');
  return {
    ok: true as const,
    record: {
      ...detail.data,
      _id: id,
      schemaVersion: 'catalog-quote-request-v1',
      keyHash: hashQuoteValue(idempotencyKey),
      fingerprint: quoteFingerprint(parsed.data),
      attentionRank: 0,
    },
  };
}
