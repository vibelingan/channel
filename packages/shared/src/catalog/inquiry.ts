import { z } from 'zod';
import { ERROR_CODES } from '../errors.ts';
import { CatalogDetailHeaderSchema, CatalogDetailVariantSchema } from './product-detail.ts';
import { CatalogQuoteFieldsSchema, CatalogQuoteTargetSchema } from './quote-draft.ts';

export const InquiryStatusSchema = z.enum([
  'new',
  'in_progress',
  'waiting_customer',
  'completed',
  'closed',
]);
export type InquiryStatus = z.infer<typeof InquiryStatusSchema>;
export const inquiryStatusLabels: Record<InquiryStatus, string> = {
  new: 'Unprocessed',
  in_progress: 'In progress',
  waiting_customer: 'Waiting for customer',
  completed: 'Completed',
  closed: 'Closed',
};
export function nextInquiryStatuses(status: InquiryStatus): InquiryStatus[] {
  switch (status) {
    case 'new':
      return ['in_progress', 'closed'];
    case 'in_progress':
      return ['waiting_customer', 'completed', 'closed'];
    case 'waiting_customer':
      return ['in_progress', 'completed', 'closed'];
    case 'completed':
    case 'closed':
      return ['in_progress'];
  }
}
export function isTerminalInquiry(status: InquiryStatus): boolean {
  return status === 'closed' || status === 'completed';
}
const version = z.number().int().nonnegative().safe();
const id = z.string().uuid();
export const InquiryCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      page: z.number().int().positive().max(100000).default(1),
      pageSize: z.number().int().positive().max(50).default(20),
      status: InquiryStatusSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal('get'), id }).strict(),
  z
    .object({
      action: z.literal('update'),
      id,
      version,
      operationId: id,
      status: InquiryStatusSchema.optional(),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
]);
export const InquiryEventSchema = z
  .object({
    id,
    actorId: z.string().min(1).max(200),
    actorName: z.string().min(1).max(200),
    at: z.string().datetime(),
    from: InquiryStatusSchema,
    to: InquiryStatusSchema,
    note: z.string().max(2000).optional(),
    version,
  })
  .strict();
export const InquirySnapshotSchema = z
  .object({
    productName: CatalogDetailHeaderSchema.shape.name,
    productId: CatalogQuoteTargetSchema.shape.productId,
    revision: CatalogQuoteTargetSchema.shape.revision,
    images: CatalogDetailHeaderSchema.shape.images,
    productOffers: CatalogDetailHeaderSchema.shape.offers,
    websitePricing: CatalogDetailHeaderSchema.shape.websitePricing,
    variant: CatalogDetailVariantSchema.optional(),
  })
  .strict();
export const InquiryDetailSchema = z
  .object({
    id,
    target: CatalogQuoteTargetSchema,
    fields: CatalogQuoteFieldsSchema,
    snapshot: InquirySnapshotSchema,
    status: InquiryStatusSchema,
    version,
    notification: z.enum(['disabled-local', 'disabled']),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    events: z.array(InquiryEventSchema).max(1000),
  })
  .strict();
export type InquiryDetail = z.infer<typeof InquiryDetailSchema>;
export const InquirySummarySchema = InquiryDetailSchema.pick({
  id: true,
  status: true,
  version: true,
  notification: true,
  createdAt: true,
  updatedAt: true,
})
  .extend({
    productName: z.string(),
    quantity: z.string(),
    intent: CatalogQuoteTargetSchema.shape.intent,
  })
  .strict();
export const InquiryDataSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('list'),
      items: z.array(InquirySummarySchema).max(50),
      total: version,
      newCount: version,
      page: z.number().int().positive(),
      pageSize: z.number().int().positive().max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal('detail'),
      item: InquiryDetailSchema,
      currentProduct: z
        .object({
          state: z.enum(['missing', 'unavailable', 'changed', 'same']),
          name: z.string().optional(),
          revision: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('updated'), id, version }).strict(),
]);
export type InquiryData = z.infer<typeof InquiryDataSchema>;
export const InquiryErrorCodeSchema = z.enum([
  ...ERROR_CODES,
  'INVALID_RECORD',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_TRANSITION',
  'REASON_REQUIRED',
  'HISTORY_LIMIT',
]);
export type InquiryErrorCode = z.infer<typeof InquiryErrorCodeSchema>;
export const InquiryEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: InquiryDataSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: InquiryErrorCodeSchema,
          message: z.string().min(1).max(2000),
          retryAfterSeconds: z.number().finite().nonnegative().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type InquiryResult = { ok: true; data: InquiryData } | { ok: false; code: InquiryErrorCode };
export type InquiryEnvelope = z.infer<typeof InquiryEnvelopeSchema>;
export const InquiryCapabilitiesSchema = z
  .object({ enabled: z.boolean(), notification: z.literal('disabled') })
  .strict();
export const inquiryErrorMessages: Partial<Record<InquiryErrorCode, string>> = {
  VALIDATION_ERROR: 'Check the requested action and note.',
  FORBIDDEN: 'Admin permission is required.',
  NOT_FOUND: 'Inquiry not found.',
  INVALID_RECORD: 'Stored inquiry needs investigation; no data was changed.',
  VERSION_CONFLICT: 'Another update was saved. Reload the latest inquiry before trying again.',
  IDEMPOTENCY_CONFLICT: 'This operation reference was used for different changes.',
  INVALID_TRANSITION: 'This status change is not allowed.',
  REASON_REQUIRED: 'Enter a reason to complete, close or reopen.',
  HISTORY_LIMIT: 'The inquiry history limit has been reached.',
};
