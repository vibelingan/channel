/** Provider-neutral detail DTO. Authorization/publication happens before projection. */
import { z } from 'zod';
import { PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT } from '../media.ts';
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
/** Text-only, reviewed content. Never contains source HTML or private evidence. */
export const CatalogContentSchema = z
  .object({
    schemaVersion: z.literal('catalog-content-v1'),
    specifications: z.array(fact).max(100),
    packaging: z.array(fact).max(100),
    notes: z.array(text(2000)).max(80),
  })
  .strict();
export type CatalogContent = z.infer<typeof CatalogContentSchema>;
export const CatalogNoteBlocksSchema = z
  .array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('heading'), text: text(200) }).strict(),
      z.object({ kind: z.literal('paragraph'), text: text(2000) }).strict(),
    ]),
  )
  .max(80);
export type CatalogNoteBlocks = z.infer<typeof CatalogNoteBlocksSchema>;
export const WebsiteDetailPricingSchema = z
  .object({
    basis: z.literal('website-manual'),
    pricing: catalogOfferPricingSchema,
  })
  .strict();
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

export const CatalogDetailHeaderSchema = PublicProductSchema.pick({ _id: true, name: true })
  .extend({
    _id: text(200),
    name: text(1000),
    schemaVersion: z.literal('catalog-product-detail-v1'),
    categoryLabel: text(1000).optional(),
    websitePricing: WebsiteDetailPricingSchema.optional(),
    descriptionText: text(30000).optional(),
    descriptionImages: z.array(image).max(PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT).optional(),
    images: z.array(image).max(9),
    facts: z.array(fact).max(100),
    offers: z.array(offer).max(32),
  })
  .strict();

/** Trusted approval snapshot, not a source observation or a generic admin write. */
export const CatalogDetailPublicationSchema = z
  .object({
    state: z.literal('approved'),
    revision: text(200),
    header: CatalogDetailHeaderSchema,
    content: CatalogContentSchema.optional(),
    noteBlocks: CatalogNoteBlocksSchema.optional(),
    variantCount: count,
    variantStorage: z.literal('immutable-v1').optional(),
  })
  .strict()
  .superRefine((publication, ctx) => {
    if (
      publication.noteBlocks &&
      (!publication.content ||
        JSON.stringify(publication.noteBlocks.map((b) => b.text)) !==
          JSON.stringify(publication.content.notes))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['noteBlocks'],
        message: 'Note blocks must preserve approved note text and order',
      });
  });

const detailBase = CatalogDetailHeaderSchema.extend({
  revision: text(200).optional(),
  variants: z
    .object({
      items: z.array(CatalogDetailVariantSchema).max(50),
      total: count,
      page: z.number().int().positive().safe(),
      pageSize: z.number().int().positive().max(50),
      hasMore: z.boolean(),
    })
    .strict(),
}).strict();
const validatePage = (
  detail: { variants: z.infer<typeof detailBase>['variants'] },
  ctx: z.RefinementCtx,
) => {
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
};

export const CatalogProductDetailSchema = detailBase.superRefine(validatePage);
/** Explicit opt-in version; the original strict v1 wire format remains unchanged. */
export const CatalogProductDetailV2Schema = detailBase
  .extend({
    schemaVersion: z.literal('catalog-product-detail-v2'),
    content: CatalogContentSchema,
  })
  .strict()
  .superRefine(validatePage);
export const CatalogProductDetailV3Schema = detailBase
  .extend({
    schemaVersion: z.literal('catalog-product-detail-v3'),
    content: CatalogContentSchema,
    noteBlocks: CatalogNoteBlocksSchema,
  })
  .strict()
  .superRefine(validatePage)
  .superRefine((detail, ctx) => {
    if (
      JSON.stringify(detail.noteBlocks.map((block) => block.text)) !==
      JSON.stringify(detail.content.notes)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['noteBlocks'],
        message: 'Note blocks must preserve approved note text and order',
      });
  });
const CatalogDetailViewSchema = z.union([
  CatalogProductDetailSchema,
  CatalogProductDetailV2Schema,
  CatalogProductDetailV3Schema,
]);
export type CatalogDetailView = z.infer<typeof CatalogDetailViewSchema>;
export function decodeCatalogDetailView(input: unknown) {
  const parsed = CatalogDetailViewSchema.safeParse(input);
  return parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const };
}

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
