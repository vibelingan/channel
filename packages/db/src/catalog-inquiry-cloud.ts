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
import {
  assertSalesInstallation,
  planSalesSubmission,
  registrationKey,
  parseSalesCaptureScope,
  createInitialSourceDelivery,
  type SalesCaptureScope,
} from './sales-inquiry-submission.ts';
import { normalizeSalesSdkDocument, assertSalesSdkWrite } from './sales-inquiry-read.ts';

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
  capture?: SalesCaptureScope,
): Promise<QuoteSaveResult> {
  const parsed = CatalogQuoteSubmissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'validation' };
  const body = parsed.data;
  const configured = capture === undefined ? undefined : parseSalesCaptureScope(capture);
  const id = quoteRequestIdentity(body.idempotencyKey);
  const now = new Date().toISOString();
  const scope =
    configured && Math.floor(Date.parse(now) / 1000) >= configured.cutover_at
      ? configured
      : undefined;
  const minute = now.slice(0, 16);
  return db.runTransaction(async (tx) => {
    const ref = tx.collection(INQUIRY_COLLECTION).doc(id);
    const prior = normalizeSalesSdkDocument(await ref.get(), id);
    if (prior)
      return prior.fingerprint === quoteFingerprint(body)
        ? { ok: true, requestId: id }
        : { ok: false, code: 'idempotency-conflict' };
    const product = normalizeSalesSdkDocument(
      await tx.collection('products').doc(body.target.productId).get(),
      body.target.productId,
    );
    const target = body.target.variantId
      ? approvedVariantTarget(product, body.target.variantId)
      : null;
    const variant = target
      ? canonicalApprovedVariant(
          target,
          normalizeSalesSdkDocument(
            await tx.collection(target.collection).doc(target.id).get(),
            target.id,
          ),
        )
      : null;
    const plan = planCatalogQuote(body, product, variant, { notification: 'disabled', now });
    if (!plan.ok) return plan;
    // One bounded durable counter document, shared across warm/cold instances.
    const limit = tx.collection(INQUIRY_LIMITS_COLLECTION).doc('public-submit');
    const current = normalizeSalesSdkDocument(await limit.get(), 'public-submit');
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
    let record: CollectionDoc = plan.record;
    let registration: Awaited<ReturnType<typeof planSalesSubmission>>['registration'] | undefined;
    if (scope) {
      const install = normalizeSalesSdkDocument(
        await tx.collection('channelSalesInstallations').doc(scope.source_installation_id).get(),
        scope.source_installation_id,
      );
      assertSalesInstallation(install?.record, scope);
      const captured = await planSalesSubmission(
        scope,
        'product',
        record,
        null,
        Math.floor(Date.parse(now) / 1000),
      );
      record = captured.project;
      registration = captured.registration;
      const key = registrationKey(registration);
      if (
        normalizeSalesSdkDocument(
          await tx.collection('channelSalesSourceRegistrations').doc(key).get(),
          key,
        )
      )
        throw new Error('Source registration conflict');
      if (
        normalizeSalesSdkDocument(
          await tx.collection('channelSalesSourceDeliveries').doc(key).get(),
          key,
        )
      )
        throw new Error('Source delivery conflict');
    }
    const { _id, ...data } = record;
    const limitAck = await limit.set({ minute, count: count + 1 });
    const savedAck = await ref.set(data);
    if (registration) {
      assertSalesSdkWrite(limitAck, 'public-submit');
      assertSalesSdkWrite(savedAck, id);
      const key = registrationKey(registration);
      assertSalesSdkWrite(
        await tx
          .collection('channelSalesSourceRegistrations')
          .doc(key)
          .set({ record: registration }),
        key,
      );
      assertSalesSdkWrite(
        await tx
          .collection('channelSalesSourceDeliveries')
          .doc(key)
          .set({ record: createInitialSourceDelivery(registration) }),
        key,
      );
    }
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
