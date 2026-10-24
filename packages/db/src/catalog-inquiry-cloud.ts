import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  InquiryCommandSchema,
  type InquiryResult,
} from '@vibelingan-channel/shared/catalog-inquiry';
import { CatalogQuoteSubmissionSchema } from '@vibelingan-channel/shared/catalog-quote';
import { approvedVariantTarget, canonicalApprovedVariant } from './catalog-detail-storage.ts';
import { processCatalogInquiry } from './catalog-inquiry.ts';
import {
  type QuoteSaveResult,
  planCatalogQuote,
  quoteFingerprint,
  quoteRequestIdentity,
} from './catalog-quote.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';

export const INQUIRY_COLLECTION = 'catalogQuoteRequests';
export const INQUIRY_LIMITS_COLLECTION = 'catalogInquiryLimits';
function doc(value: unknown): CollectionDoc | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (row == null) return null;
  if (typeof row !== 'object' || !('_id' in row) || typeof row._id !== 'string')
    throw new Error('Malformed CloudBase document');
  return row as CollectionDoc;
}
export async function saveQuoteInCloud(
  db: NodeSdkDatabase,
  input: unknown,
): Promise<QuoteSaveResult> {
  const parsed = CatalogQuoteSubmissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'validation' };
  const body = parsed.data;
  const id = quoteRequestIdentity(body.idempotencyKey);
  const now = new Date().toISOString();
  const minute = now.slice(0, 16);
  return db.runTransaction(async (tx) => {
    const ref = tx.collection(INQUIRY_COLLECTION).doc(id);
    const prior = doc((await ref.get()).data);
    if (prior)
      return prior.fingerprint === quoteFingerprint(body)
        ? { ok: true, requestId: id }
        : { ok: false, code: 'idempotency-conflict' };
    const product = doc((await tx.collection('products').doc(body.target.productId).get()).data);
    const target = body.target.variantId
      ? approvedVariantTarget(product, body.target.variantId)
      : null;
    const variant = target
      ? canonicalApprovedVariant(
          target,
          doc((await tx.collection(target.collection).doc(target.id).get()).data),
        )
      : null;
    const plan = planCatalogQuote(body, product, variant, { notification: 'disabled', now });
    if (!plan.ok) return plan;
    // One bounded durable counter document, shared across warm/cold instances.
    const limit = tx.collection(INQUIRY_LIMITS_COLLECTION).doc('public-submit');
    const current = doc((await limit.get()).data);
    if (
      current &&
      (typeof current.minute !== 'string' ||
        typeof current.count !== 'number' ||
        !Number.isSafeInteger(current.count) ||
        current.count < 0)
    )
      return { ok: false, code: 'rate-limit' };
    const count =
      current?.minute === minute && typeof current.count === 'number' ? current.count : 0;
    if (count >= 30) return { ok: false, code: 'rate-limit' };
    const { _id, ...data } = plan.record;
    await limit.set({ minute, count: count + 1 });
    await ref.set(data);
    return { ok: true, requestId: _id };
  });
}
export async function manageInquiryInCloud(
  db: NodeSdkDatabase,
  actorId: string,
  input: unknown,
): Promise<InquiryResult> {
  const parsed = InquiryCommandSchema.safeParse(input);
  if (!parsed.success || parsed.data.action === 'list')
    return { ok: false, code: 'VALIDATION_ERROR' };
  const command = parsed.data;
  return db.runTransaction(async (tx) => {
    const actor = doc((await tx.collection('users').doc(actorId).get()).data);
    if (!actor || actor.role !== 'admin' || actor.status === 'suspended')
      return { ok: false, code: 'FORBIDDEN' };
    const ref = tx.collection(INQUIRY_COLLECTION).doc(command.id);
    const row = doc((await ref.get()).data);
    const target = row?.target;
    const productId =
      target &&
      typeof target === 'object' &&
      'productId' in target &&
      typeof target.productId === 'string'
        ? target.productId
        : undefined;
    const product =
      command.action === 'get' && productId
        ? doc((await tx.collection('products').doc(productId).get()).data)
        : null;
    const outcome = processCatalogInquiry(
      {
        users: [actor],
        catalogQuoteRequests: row ? [row] : [],
        products: product ? [product] : [],
      },
      actorId,
      command,
    );
    if (outcome.changed) {
      const { _id, ...data } = outcome.changed;
      await ref.set(data);
    }
    return outcome.result;
  });
}
