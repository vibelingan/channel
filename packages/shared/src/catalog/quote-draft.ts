import { z } from 'zod';
import { CountryCodeSchema } from '../countries.ts';

const requiredText = (max: number) => z.string().trim().min(1, 'required').max(max, 'too-long');
const intent = z.enum(['variant_quote', 'customization']);
export const customizationTypes = [
  'logo',
  'packaging',
  'material',
  'color',
  'certification',
  'other',
] as const;
const quantity = z
  .string()
  .max(16, 'quantity')
  .regex(/^[1-9][0-9]*$/, 'quantity')
  .refine((value) => Number.isSafeInteger(Number(value)), 'quantity');
function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Buyer-entered fields only. No price, product display snapshot or receipt. */
export const CatalogQuoteFieldsSchema = z
  .object({
    intent,
    quantity,
    deliveryDate: z.string().refine((value) => !value || calendarDate(value), 'delivery-date'),
    customizationTypes: z
      .array(z.enum(customizationTypes))
      .max(6, 'customization')
      .refine((values) => new Set(values).size === values.length, 'customization'),
    brief: z.string().trim().max(2000, 'too-long'),
    contactName: requiredText(120),
    email: z.string().trim().max(254, 'too-long').email('email'),
    company: requiredText(200),
    country: CountryCodeSchema,
  })
  .strict()
  .superRefine((fields, ctx) => {
    if (fields.intent === 'customization') {
      if (!fields.customizationTypes.length)
        ctx.addIssue({ code: 'custom', path: ['customizationTypes'], message: 'customization' });
      if (fields.brief.length < 10)
        ctx.addIssue({ code: 'custom', path: ['brief'], message: 'brief' });
    } else if (fields.customizationTypes.length) {
      ctx.addIssue({ code: 'custom', path: ['customizationTypes'], message: 'customization' });
    }
  });
export type CatalogQuoteFields = z.infer<typeof CatalogQuoteFieldsSchema>;
/** Caller supplies its calendar day; a future endpoint must supply server time. */
export const quoteFieldsForDate = (today: string) =>
  CatalogQuoteFieldsSchema.superRefine((fields, ctx) => {
    if (!calendarDate(today) || (fields.deliveryDate && fields.deliveryDate < today))
      ctx.addIssue({ code: 'custom', path: ['deliveryDate'], message: 'delivery-date' });
  });
const identity = z.string().trim().min(1).max(200);
export const CatalogQuoteTargetSchema = z
  .object({
    intent,
    productId: identity,
    revision: identity,
    variantId: identity.optional(),
  })
  .strict();
export type CatalogQuoteTarget = z.infer<typeof CatalogQuoteTargetSchema>;
export const CatalogQuoteSubmissionSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    target: CatalogQuoteTargetSchema,
    fields: CatalogQuoteFieldsSchema,
  })
  .strict()
  .refine((value) => value.target.intent === value.fields.intent, 'intent-mismatch');
export type CatalogQuoteSubmission = z.infer<typeof CatalogQuoteSubmissionSchema>;
export type QuoteCurrentContext = {
  available: boolean;
  productId: string;
  revision: string;
  variant?: { id: string; productId: string };
};
/** Pure business policy; not an authorization gate by itself. Server callers MUST
 * construct current from fresh authorized DB reads, never the request body. */
export function validateQuoteTarget(
  target: unknown,
  current: QuoteCurrentContext,
): string | undefined {
  const parsed = CatalogQuoteTargetSchema.safeParse(target);
  if (!parsed.success) return 'invalid-target';
  if (!current.available) return 'unavailable';
  const value = parsed.data;
  if (value.productId !== current.productId || value.revision !== current.revision)
    return 'stale-context';
  if (value.intent === 'variant_quote' && !value.variantId) return 'variant-required';
  if (
    value.variantId &&
    (value.variantId !== current.variant?.id || current.variant.productId !== current.productId)
  )
    return 'invalid-variant';
  return undefined;
}
