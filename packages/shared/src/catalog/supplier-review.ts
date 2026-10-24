/**
 * Supplier review on a product (DEC-19, DEC-20). A supplier change never
 * reaches the website text or photos without the admin: for each part the
 * admin decides Keep or Use incoming, and the decision is tied to the exact
 * incoming value it was made for (its digest), so a newer supplier value asks
 * again. Configuration photos let the admin say which gallery photos show a
 * configuration when Alibaba does not.
 */
import { z } from 'zod';
import { catalogOfferPricingSchema } from './offer-pricing.ts';

/** The website parts an admin owns and decides on. */
export const SUPPLIER_REVIEW_PARTS = ['description', 'gallery', 'descriptionImages'] as const;
export type SupplierReviewPartName = (typeof SUPPLIER_REVIEW_PARTS)[number];

const decision = z
  .object({
    choice: z.enum(['keep', 'incoming']),
    incomingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const SupplierDecisionsSchema = z
  .object({ description: decision, gallery: decision, descriptionImages: decision })
  .partial()
  .strict();
export type SupplierDecisions = z.infer<typeof SupplierDecisionsSchema>;

const imageId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const CONFIGURATION_PHOTO_LIMIT = 9;
export const ConfigurationPhotosSchema = z
  .record(z.string().trim().min(1).max(200), z.array(imageId).max(CONFIGURATION_PHOTO_LIMIT))
  .refine((value) => Object.keys(value).length <= 500, 'At most 500 configurations');
export type ConfigurationPhotos = z.infer<typeof ConfigurationPhotosSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pricingList = z.array(catalogOfferPricingSchema);
const fact = z.object({ name: z.string(), value: z.string() }).passthrough();

/** One admin-owned part whose supplier value differs from the website's. */
export const SupplierReviewPartSchema = z
  .object({
    part: z.enum(SUPPLIER_REVIEW_PARTS),
    website: z
      .object({ text: z.string().optional(), imageIds: z.array(z.string()).optional() })
      .strict(),
    incoming: z
      .object({
        text: z.string().optional(),
        urls: z.array(z.string()).optional(),
        /** Our image id for each incoming photo already imported, else null. */
        imageIds: z.array(z.string().nullable()).optional(),
      })
      .strict(),
    /** Where the website value came from: Alibaba at the last approval, an admin edit, or unknown. */
    origin: z.enum(['supplier', 'admin', 'unknown']),
    incomingDigest: digest,
    /** The admin's decision for exactly this incoming value, if made. */
    decision: z.enum(['keep', 'incoming']).optional(),
  })
  .strict();
export type SupplierReviewPart = z.infer<typeof SupplierReviewPartSchema>;

/** The read-only answer of `catalogDetailApproval {action: 'supplier-review'}`. */
export const SupplierReviewSchema = z
  .object({
    ok: z.literal(true),
    parts: z.array(SupplierReviewPartSchema),
    /** Taken from Alibaba on approval, shown old → new; null before a first approval. */
    changes: z
      .object({
        configurationsAdded: z.array(z.string()),
        configurationsRemoved: z.array(z.string()),
        prices: z.array(
          z.object({ configuration: z.string(), before: pricingList, after: pricingList }).strict(),
        ),
        options: z.array(z.string()),
        productPrice: z.object({ before: pricingList, after: pricingList }).strict().optional(),
        facts: z
          .object({ before: z.array(fact), after: z.array(fact) })
          .strict()
          .optional(),
      })
      .strict()
      .nullable(),
    /** Each configuration with its supplier photos (null: not imported) and the admin's choice. */
    configurations: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          supplierImageIds: z.array(z.string()).nullable(),
          adminImageIds: z.array(z.string()).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type SupplierReview = z.infer<typeof SupplierReviewSchema>;
