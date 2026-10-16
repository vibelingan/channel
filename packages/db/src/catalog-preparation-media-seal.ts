/** Bounded attestation of an ordered adopted image set. This is not a product ready report. */
import { CATALOG_MEDIA_SEAL_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { CatalogImageObservationHealth } from './catalog-image-observation.ts';
import { CATALOG_PIXEL_POLICY } from './catalog-protected-pixels.ts';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
export { CATALOG_MEDIA_SEAL_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
export function initialCatalogImageIdsDigest() {
  return alibabaPricingFingerprint([CATALOG_MEDIA_SEAL_POLICY, 'image-ids']);
}
export function advanceCatalogImageIdsDigest(previous: string, imageId: string) {
  return alibabaPricingFingerprint([previous, imageId]);
}
export function catalogSealedImageIdsDigest(imageIds: readonly string[]) {
  return imageIds.reduce(advanceCatalogImageIdsDigest, initialCatalogImageIdsDigest());
}
export const CatalogPreparationMediaSealSchema = z
  .object({
    policyVersion: z.literal(CATALOG_MEDIA_SEAL_POLICY),
    pixelPolicyVersion: z.string().trim().min(1).max(100),
    planDigest: hex,
    total: integer,
    cursor: integer,
    imageIdsDigest: hex,
    lastImageId: z.string().min(1).max(200).nullable(),
    lastReceipt: hex.nullable(),
  })
  .strict()
  .refine(
    (s) =>
      s.cursor <= s.total &&
      (s.cursor === 0
        ? s.lastImageId === null &&
          s.lastReceipt === null &&
          s.imageIdsDigest === initialCatalogImageIdsDigest()
        : s.lastImageId !== null && s.lastReceipt !== null),
  );
export type CatalogPreparationMediaSeal = z.infer<typeof CatalogPreparationMediaSealSchema>;
export function initialCatalogMediaSeal(
  planDigest: string,
  total: number,
): CatalogPreparationMediaSeal {
  return CatalogPreparationMediaSealSchema.parse({
    policyVersion: CATALOG_MEDIA_SEAL_POLICY,
    pixelPolicyVersion: CATALOG_PIXEL_POLICY,
    planDigest,
    total,
    cursor: 0,
    imageIdsDigest: initialCatalogImageIdsDigest(),
    lastImageId: null,
    lastReceipt: null,
  });
}
export function advanceCatalogMediaSeal(
  current: CatalogPreparationMediaSeal,
  input: {
    index: number;
    imageId: string;
    imageInputDigest: string;
    health: Extract<CatalogImageObservationHealth, { status: 'verified' }>;
  },
): CatalogPreparationMediaSeal | null {
  if (
    current.policyVersion !== CATALOG_MEDIA_SEAL_POLICY ||
    current.pixelPolicyVersion !== CATALOG_PIXEL_POLICY ||
    input.health.imageId !== input.imageId ||
    input.health.inputDigest !== input.imageInputDigest
  )
    return null;
  const receipt = alibabaPricingFingerprint([
    CATALOG_MEDIA_SEAL_POLICY,
    CATALOG_PIXEL_POLICY,
    current.planDigest,
    input.index,
    input.imageId,
    input.imageInputDigest,
    input.health,
  ]);
  if (
    input.index === current.cursor - 1 &&
    current.lastReceipt === receipt &&
    current.lastImageId === input.imageId
  )
    return current;
  if (
    input.index !== current.cursor ||
    input.index >= current.total ||
    (current.lastImageId !== null && input.imageId <= current.lastImageId)
  )
    return null;
  return CatalogPreparationMediaSealSchema.parse({
    ...current,
    cursor: current.cursor + 1,
    imageIdsDigest: advanceCatalogImageIdsDigest(current.imageIdsDigest, input.imageId),
    lastImageId: input.imageId,
    lastReceipt: receipt,
  });
}
