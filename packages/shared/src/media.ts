/**
 * Media asset vocabulary and validation shared across the admin function,
 * public-api function, local-server, and the storage adapter.
 *
 * Why this lives in `shared` and not in the collection registry: the registry's
 * `buildWriteSchema` filters out `readOnly` fields BEFORE compiling `select`
 * enums, so a read-only `select` (e.g. `purpose`, `status`) is never
 * enum-enforced on a generic write. Storage-backed image documents are written
 * only through dedicated media actions (via the trusted `createDoc`/`updateDoc`
 * writers), and those actions validate their input against the schemas below.
 *
 * See docs/IMAGE_UPLOAD_STORAGE_DESIGN.md §20.3 (MIU-01) and §23.
 */
import { z } from 'zod';

/** Purpose of an uploaded media asset; drives policy (size, MIME, visibility). */
export const MEDIA_PURPOSES = [
  'catalog-image',
  'catalog-thumbnail',
  'marketing-media',
  'oem-drawing',
  'inline-small',
] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

/** Where the bytes physically live. `legacy-base64` is read-only compatibility. */
export const IMAGE_STORAGE_PROVIDERS = [
  'legacy-base64',
  'cloudbase-storage',
  'local-disk',
] as const;
export type ImageStorageProvider = (typeof IMAGE_STORAGE_PROVIDERS)[number];

/** Storage backend mode; classic NoSQL storage is the current CloudBase env. */
export const IMAGE_STORAGE_MODES = ['classic-nosql-storage', 'pg-storage', 'local-disk'] as const;
export type ImageStorageMode = (typeof IMAGE_STORAGE_MODES)[number];

/** Lifecycle of a media document. Only `active` records are publicly servable. */
export const MEDIA_STATUSES = ['pending', 'active', 'failed', 'deleted'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** Generated variant roles for a single source image. */
export const VARIANT_ROLES = ['original', 'detail', 'card', 'thumb'] as const;
export type VariantRole = (typeof VARIANT_ROLES)[number];

/**
 * Catalog product-image upload policy. Referenced by MIU-03 (admin upload
 * action) and MIU-05 (admin UI). The max is the enforced production ceiling
 * once a transport is selected in MIU-00.
 */
export const CATALOG_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CATALOG_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/**
 * SVG is active/vector content. Advisory/UX list only — enforcement is the
 * `CATALOG_IMAGE_MIME_TYPES` allowlist: any value not on it (SVG included) is
 * rejected by `catalogImageUploadSchema`. Legacy SVGs still read via the
 * `legacy-base64` path.
 */
export const BLOCKED_IMAGE_MIME_TYPES = ['image/svg+xml'] as const;

/** Metadata for one generated variant of a source image. */
export interface ImageVariantMetadata {
  role: VariantRole;
  storageProvider: 'cloudbase-storage' | 'local-disk';
  storageFileId: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  checksumSha256?: string;
}

/**
 * A row as it actually exists in the `images` collection.
 *
 * IMPORTANT: legacy/pre-migration rows (e.g. seeded base64 SVGs — see
 * apps/local-server/src/seed.ts) carry ONLY `_id`/`name`/`mimeType`/`data` and
 * NONE of the media-metadata fields. Storage-backed rows (written by the
 * admin-brokered upload MIU) carry the full set. So every field beyond
 * `_id`/`name`/`mimeType` is OPTIONAL at the persistence layer: consumers must
 * default rather than trust presence — `storageProvider ?? 'legacy-base64'`,
 * treat absent `status` as legacy-active, `publishedRefCount ?? 0`, etc. A
 * normalizer / `publishedRefCount` backfill that turns these raw rows into a
 * trusted shape is defined in MIU-04 (public delivery + visibility index), not
 * here. Do not gate visibility on the bare required-ness of these fields.
 */
export interface ImageMetadataDoc {
  _id: string;
  name: string;
  mimeType: string;
  // Present on storage-backed rows; ABSENT on legacy/pre-migration rows.
  purpose?: MediaPurpose;
  storageProvider?: ImageStorageProvider;
  storageMode?: ImageStorageMode;
  storageFileId?: string;
  storagePath?: string;
  byteSize?: number;
  // Optional top-level source dimensions; per-variant dimensions live on
  // ImageVariantMetadata. Server-managed and intentionally absent from the
  // generic `images` registry (set only by dedicated media actions).
  width?: number;
  height?: number;
  checksumSha256?: string;
  // Lifecycle fields — present on storage-backed rows, ABSENT on legacy rows.
  // MIU-04 normalizes/backfills these before public delivery trusts them.
  status?: MediaStatus;
  publishedRefCount?: number;
  variants?: ImageVariantMetadata[];
  /** Legacy base64 bytes; only set when `storageProvider === 'legacy-base64'`. */
  data?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Build a zod string-enum from a readonly non-empty tuple, preserving the
 * literal union in the inferred type. Spreading into a fresh (mutable) array
 * keeps the literal tuple type `[...T]` while dropping the
 * `as [string, ...string[]]` cast that would otherwise widen the schema output
 * to plain `string` — which erases compile-time MIME narrowing downstream.
 */
function stringEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z.enum([...values]);
}

/**
 * Validation for an incoming catalog-image upload request. The admin upload
 * action (MIU-03) parses the multipart/form metadata through this before
 * writing a `pending` image document. `byteSize` is validated here; the action
 * additionally recomputes the SHA-256 server-side rather than trusting the
 * client (§23 / §22.3-6).
 */
export const catalogImageUploadSchema = z.object({
  fileName: z.string().min(1, 'File name is required'),
  mimeType: stringEnum(CATALOG_IMAGE_MIME_TYPES),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(CATALOG_IMAGE_MAX_BYTES, `Image exceeds ${CATALOG_IMAGE_MAX_BYTES} bytes`),
  checksumSha256: z.string().optional(),
  purpose: z.literal('catalog-image').default('catalog-image'),
});
export type CatalogImageUploadInput = z.infer<typeof catalogImageUploadSchema>;
