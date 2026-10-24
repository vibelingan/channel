import { CATALOG_IMAGE_MAX_BYTES } from '@vibelingan-channel/shared';
import { z } from 'zod';
export const CATALOG_STORAGE_PROTECTION_POLICY = 'catalog-protected-target-v1';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => s.trim() === s);
const instant = z
  .string()
  .datetime()
  .refine((s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s);
const mode = z.enum(['classic-nosql-storage', 'local-disk']);
const provider = z.enum(['cloudbase-storage', 'local-disk']);
export const CatalogProtectedTargetSchema = z
  .object({
    storageProvider: provider,
    storageMode: mode,
    storageFileId: z
      .string()
      .min(1)
      .max(8192)
      .refine((s) => s.trim() === s),
    storagePath: z.string().min(1).max(2048),
    byteSize: z.number().int().positive().max(CATALOG_IMAGE_MAX_BYTES),
  })
  .strict()
  .refine((t) =>
    t.storageProvider === 'local-disk'
      ? t.storageMode === 'local-disk'
      : t.storageMode === 'classic-nosql-storage',
  );
export const CatalogImageProtectionIntentSchema = z
  .object({
    _id: hex,
    kind: z.literal('catalog-image-protection-intent-v1'),
    policyVersion: z.literal(CATALOG_STORAGE_PROTECTION_POLICY),
    imageId: id,
    imageIdentity: hex,
    sourceInputDigest: hex,
    sourceStorageProvider: provider,
    sourceStorageMode: mode.nullable(),
    sourceStorageFileId: z.string().min(1).max(8192),
    sourceStoragePath: z.string().max(2048).nullable(),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    byteSize: z.number().int().positive().max(CATALOG_IMAGE_MAX_BYTES),
    checksumSha256: hex,
    attemptId: hex,
    state: z.enum(['reserved', 'targeted', 'committed']),
    jobId: hex,
    leaseVersion: z.number().int().positive().safe(),
    leaseOwner: id,
    owner: hex,
    target: CatalogProtectedTargetSchema.nullable(),
    targetInputDigest: hex.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict()
  .refine(
    (r) =>
      r.updatedAt >= r.createdAt &&
      (r.state === 'reserved'
        ? r.target === null && r.targetInputDigest === null
        : r.state === 'targeted'
          ? r.target !== null && r.targetInputDigest === null
          : r.target !== null && r.targetInputDigest !== null),
  );
export type CatalogImageProtectionIntent = z.infer<typeof CatalogImageProtectionIntentSchema>;
export const CatalogImageStorageProtectionSchema = z
  .object({
    kind: z.literal('catalog-protected-target-v1'),
    intentId: hex,
    imageId: id,
    attemptId: hex,
    targetInputDigest: hex,
  })
  .strict();
