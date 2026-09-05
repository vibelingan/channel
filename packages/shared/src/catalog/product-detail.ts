/** Provider-neutral detail DTO. Authorization/publication happens before projection. */
import { z } from 'zod';
import { PublicProductSchema } from './index.ts';
import { catalogOfferPricingSchema } from './offer-pricing.ts';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim() === v);
const count = z.number().int().nonnegative().safe();
const image = z.string().regex(/^\/api\/images\/[A-Za-z0-9_-]+$/);
const fact = z.object({ name: text(200), value: text(2000) }).strict();
const offer = z
  .object({
    kind: z.enum(['supplier', 'regular', 'promotion']),
    basis: z.literal('source-quote'),
    pricing: catalogOfferPricingSchema,
  })
  .strict();
const inventory = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }).strict(),
  z.object({ state: z.literal('conflict') }).strict(),
  z
    .object({
      state: z.literal('reported'),
      quantity: count,
      semantics: z.enum(['onHand', 'sellable']),
      basis: z.literal('source'),
    })
    .strict(),
]);

export const CatalogDetailVariantSchema = z
  .object({
    id: text(200),
    sku: text(200).optional(),
    options: z.array(fact).max(50),
    images: z.array(image).max(9),
    inventory,
    offers: z.array(offer).max(32),
  })
  .strict();

export const CatalogProductDetailSchema = PublicProductSchema.pick({ _id: true, name: true })
  .extend({
    _id: text(200),
    name: text(1000),
    schemaVersion: z.literal('catalog-product-detail-v1'),
    categoryLabel: text(1000).optional(),
    descriptionText: text(30000).optional(),
    images: z.array(image).max(9),
    facts: z.array(fact).max(100),
    offers: z.array(offer).max(32),
    variants: z
      .object({
        items: z.array(CatalogDetailVariantSchema).max(50),
        total: count,
        page: z.number().int().positive().safe(),
        pageSize: z.number().int().positive().max(50),
        hasMore: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((detail, ctx) => {
    const { items, page, pageSize, total, hasMore } = detail.variants;
    const offset = (page - 1) * pageSize;
    const expected = Math.max(0, Math.min(pageSize, total - offset));
    if (
      !Number.isSafeInteger(offset) ||
      items.length !== expected ||
      hasMore !== offset + items.length < total
    ) {
      ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Inconsistent variant page' });
    }
    if (new Set(items.map((v) => v.id)).size !== items.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants', 'items'],
        message: 'Duplicate canonical variant ID',
      });
    }
  });

export type CatalogProductDetail = z.infer<typeof CatalogProductDetailSchema>;
export type CatalogDetailVariant = z.infer<typeof CatalogDetailVariantSchema>;

export function decodeCatalogProductDetail(input: unknown) {
  const parsed = CatalogProductDetailSchema.safeParse(input);
  return parsed.success
    ? { ok: true as const, value: parsed.data }
    : {
        ok: false as const,
        errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      };
}
