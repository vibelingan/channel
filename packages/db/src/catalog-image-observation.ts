/** Historical check observations, never immutable-storage seals or publication authority. */
import { CATALOG_IMAGE_MAX_BYTES } from '@vibelingan-channel/shared';
import { CATALOG_PREPARATION_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
export const CATALOG_IMAGE_OBSERVATIONS = 'catalogImageObservations';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const CatalogImageObservationHealthSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('verified'),
      kind: z.literal('stored-image-health-v1'),
      imageId: id,
      inputDigest: hex,
      byteSize: count.max(CATALOG_IMAGE_MAX_BYTES),
      checksumSha256: hex,
      width: count,
      height: count,
      pages: count,
    })
    .strict(),
  z
    .object({
      status: z.literal('invalid'),
      reason: z.enum(['record', 'size', 'checksum', 'content']),
    })
    .strict(),
  z
    .object({
      status: z.literal('retry'),
      reason: z.enum(['busy', 'unavailable', 'changed', 'timeout']),
    })
    .strict(),
]);
export const CatalogImageObservationRecordSchema = z
  .object({
    _id: hex,
    kind: z.literal('unsealed-image-observation-v1'),
    policyVersion: z.literal(CATALOG_PREPARATION_POLICY),
    jobId: hex,
    productId: id,
    inputDigest: hex,
    contentGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    imageId: id,
    imageInputDigest: hex.nullable(),
    checkedAt: z
      .string()
      .max(40)
      .datetime()
      .refine((value) => {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
      }),
    health: CatalogImageObservationHealthSchema,
  })
  .strict();
export type CatalogImageObservation = z.infer<typeof CatalogImageObservationRecordSchema>;
export type CatalogImageObservationHealth = z.infer<typeof CatalogImageObservationHealthSchema>;
