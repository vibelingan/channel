/** Reusable pixel evidence for an application-owned immutable target, never product readiness. */
import { isDeepStrictEqual } from 'node:util';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { readImageMutationState } from './adapter.ts';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import { storedCatalogImageInputDigest } from './catalog-image-input.ts';
import {
  CATALOG_IMAGE_OBSERVATIONS,
  type CatalogImageObservationHealth,
  CatalogImageObservationHealthSchema,
} from './catalog-image-observation.ts';
import {
  readCatalogImageProtectionIntent,
  readCatalogImageStorageProtection,
} from './catalog-image-protection.ts';

// Bump when the native pixel acceptance contract changes, independently of website content rules.
export const CATALOG_PIXEL_POLICY = 'catalog-pixels-v1';
type Verified = Extract<CatalogImageObservationHealth, { status: 'verified' }>;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z
  .object({
    _id: hex,
    kind: z.literal('catalog-protected-image-health-v1'),
    policyVersion: z.literal(CATALOG_PIXEL_POLICY),
    imageId: z.string().min(1).max(200),
    inputDigest: hex,
    intentId: hex,
    attemptId: hex,
    health: CatalogImageObservationHealthSchema.refine(
      (h): h is Verified => h.status === 'verified',
    ),
    checkedAt: z
      .string()
      .datetime()
      .refine((s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s),
  })
  .strict();
function cacheId(imageId: string, digest: string) {
  return alibabaPricingFingerprint([CATALOG_PIXEL_POLICY, imageId, digest]);
}
async function binding(tx: Pick<CatalogApprovalTransaction, 'get'>, image: CollectionDoc | null) {
  const marker = readCatalogImageStorageProtection(image);
  if (!image || !marker || readImageMutationState(image).state !== 'free') return null;
  const intent = readCatalogImageProtectionIntent(
    await tx.get(CATALOG_IMAGE_OBSERVATIONS, marker.intentId),
    marker.intentId,
  );
  if (
    !intent ||
    intent.state !== 'committed' ||
    intent.imageId !== image._id ||
    intent.attemptId !== marker.attemptId ||
    intent.targetInputDigest !== marker.targetInputDigest
  )
    return null;
  return { image, marker, digest: storedCatalogImageInputDigest(image) };
}
function matches(health: Verified, image: CollectionDoc, digest: string) {
  return (
    health.imageId === image._id &&
    health.inputDigest === digest &&
    health.checksumSha256 === image.checksumSha256 &&
    health.byteSize === image.byteSize
  );
}
function readRecord(
  raw: unknown,
  b: NonNullable<Awaited<ReturnType<typeof binding>>>,
  now: number,
) {
  const r = recordSchema.safeParse(raw);
  if (!r.success) return null;
  const v = r.data;
  return v._id === cacheId(b.image._id, b.digest) &&
    v.imageId === b.image._id &&
    v.inputDigest === b.digest &&
    v.intentId === b.marker.intentId &&
    v.attemptId === b.marker.attemptId &&
    Date.parse(v.checkedAt) <= now + 5000 &&
    matches(v.health, b.image, b.digest)
    ? v
    : null;
}
export async function readCatalogProtectedPixels(
  tx: Pick<CatalogApprovalTransaction, 'get'>,
  image: CollectionDoc | null,
  now: number,
): Promise<Verified | null> {
  const b = await binding(tx, image);
  if (!b) return null;
  return (
    readRecord(await tx.get(CATALOG_IMAGE_OBSERVATIONS, cacheId(b.image._id, b.digest)), b, now)
      ?.health ?? null
  );
}
/** Read all dependencies before the caller writes observation/cursor/cache in one transaction. */
export async function planCatalogProtectedPixels(
  tx: Pick<CatalogApprovalTransaction, 'get'>,
  image: CollectionDoc | null,
  health: CatalogImageObservationHealth,
  checkedAt: string,
): Promise<CollectionDoc | null> {
  if (health.status !== 'verified') return null;
  const b = await binding(tx, image);
  if (!b || !matches(health, b.image, b.digest)) return null;
  const id = cacheId(b.image._id, b.digest);
  const old = readRecord(await tx.get(CATALOG_IMAGE_OBSERVATIONS, id), b, Date.parse(checkedAt));
  if (old && isDeepStrictEqual(old.health, health)) return null;
  return recordSchema.parse({
    _id: id,
    kind: 'catalog-protected-image-health-v1',
    policyVersion: CATALOG_PIXEL_POLICY,
    imageId: b.image._id,
    inputDigest: b.digest,
    intentId: b.marker.intentId,
    attemptId: b.marker.attemptId,
    health,
    checkedAt,
  });
}
