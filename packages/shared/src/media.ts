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
/** Maximum ordered source images accepted or exposed for one catalog document. */
export const CATALOG_IMAGE_MAX_COUNT = 18;
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
 * A storage-backed image row with its lifecycle/storage invariants REQUIRED.
 *
 * `ImageMetadataDoc` above is the raw at-rest shape: every media field is
 * optional because legacy/pre-migration rows lack them. That honesty makes it
 * too weak as the contract for NEW rows — so media actions (MIU-Upload) write,
 * and public delivery (MIU-04) consumes, through THIS stricter type, where
 * `purpose`/`storageProvider`/`storageFileId`/`storagePath`/`status`/
 * `publishedRefCount` are all required and the provider excludes
 * `legacy-base64`. Use `isStorageBackedImage()` to narrow a raw row.
 */
export interface StorageBackedImageMetadataDoc {
  _id: string;
  name: string;
  mimeType: string;
  purpose: MediaPurpose;
  storageProvider: 'cloudbase-storage' | 'local-disk';
  storageMode?: ImageStorageMode;
  storageFileId: string;
  storagePath: string;
  byteSize?: number;
  width?: number;
  height?: number;
  checksumSha256?: string;
  status: MediaStatus;
  publishedRefCount: number;
  variants?: ImageVariantMetadata[];
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Narrow a raw at-rest row to the storage-backed contract: a non-legacy
 * provider plus all required storage + lifecycle fields present. Legacy rows
 * (and incompletely-written rows) return false, forcing callers to handle them
 * (e.g. via the legacy-base64 read path) rather than mistreating them.
 */
export function isStorageBackedImage(doc: ImageMetadataDoc): doc is StorageBackedImageMetadataDoc {
  return (
    (doc.storageProvider === 'cloudbase-storage' || doc.storageProvider === 'local-disk') &&
    typeof doc.storageFileId === 'string' &&
    typeof doc.storagePath === 'string' &&
    // Validate enum MEMBERSHIP, not just `typeof string` — a row with a garbage
    // `purpose`/`status` must not be narrowed to the closed literal unions.
    (MEDIA_PURPOSES as readonly string[]).includes(doc.purpose ?? '') &&
    (MEDIA_STATUSES as readonly string[]).includes(doc.status ?? '') &&
    typeof doc.publishedRefCount === 'number'
  );
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

// --- Marketing media (public-site video) policy ----------------------------

/**
 * Max size for a SINGLE self-service marketing video (e.g. a client-uploaded
 * factory walkthrough). 200 MiB comfortably covers a 2–4 min 1080p H.264/WebM
 * clip while staying well under CloudBase Storage's single-PUT ceiling. Note
 * the CloudBase free tier grants only ~5 GiB total storage + limited monthly
 * CDN traffic, so budget for a small number of these (verify the env's real
 * quota in the console before enabling client self-service upload).
 *
 * Files ABOVE this must use a chunked / resumable (multipart) upload — a direct
 * browser POST of >200 MiB is unreliable on flaky networks and can exceed
 * function/gateway request ceilings. That larger-file path is intentionally NOT
 * built yet (see docs/IMAGE_UPLOAD_STORAGE_DESIGN.md "marketing-media").
 */
export const MARKETING_VIDEO_MAX_BYTES = 200 * 1024 * 1024;

/** Accepted marketing video MIME types (web-deliverable, broadly supported). */
export const MARKETING_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;

// --- OEM file (attachment) policy — MIU-08 ---------------------------------

/** Max size for a single public OEM attachment (P0). */
export const OEM_FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Max length of the LEGACY inline `drawingData` base64 string on `submitProject`.
 * The storage-triad path caps attachments at `OEM_FILE_MAX_BYTES`; the legacy
 * inline path must match it rather than admit an arbitrarily large body. base64
 * encodes 3 bytes → 4 chars, so N bytes ⇒ ceil(N/3)*4 chars. This is the schema
 * first-line guard; the handler additionally decodes and checks the real
 * `byteLength` against `OEM_FILE_MAX_BYTES` for an exact cap.
 */
export const OEM_LEGACY_DRAWING_MAX_BASE64_CHARS = Math.ceil(OEM_FILE_MAX_BYTES / 3) * 4;

/**
 * Accepted OEM attachment extensions (lowercase, no dot). Images + archives have
 * reliable magic bytes (cross-checked post-upload); CAD formats have no universal
 * signature and stay EXTENSION-gated here by policy.
 */
export const OEM_FILE_EXTENSIONS = [
  'pdf',
  'zip',
  'rar',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'step',
  'stp',
  'igs',
  'iges',
  'dwg',
  'dxf',
] as const;
export type OemFileExtension = (typeof OEM_FILE_EXTENSIONS)[number];

/** Public upload-intent abuse-control limits (design §20.10). */
export const OEM_UPLOAD_INTENT_TTL_MS = 15 * 60 * 1000;
export const OEM_MAX_PENDING_INTENTS_PER_SOURCE = 3;
export const OEM_UPLOAD_RATE_WINDOW_MS = 60 * 1000;
export const OEM_UPLOAD_RATE_MAX_PER_WINDOW = 5;

/**
 * Global emergency ceilings for the public OEM intent endpoint, enforced IN
 * ADDITION to the per-source caps above. Because CloudBase Event Functions may
 * not expose a trusted client IP consistently (§20.10), a spoofed/absent source
 * would collapse every request into one bucket; these site-wide ceilings bound
 * total abuse in that case without throttling a normal per-source stream. They
 * are deliberately higher than the per-source caps (a real B2B OEM form is
 * low-volume, so headroom here is generous but still finite).
 */
export const OEM_UPLOAD_RATE_MAX_PER_WINDOW_GLOBAL = 30;
export const OEM_MAX_PENDING_INTENTS_GLOBAL = 50;

/**
 * TTL for the admin OEM-file download temp URL. Deliberately short (§20.10):
 * MIU-00 observed CDN edges can outlive object deletion, so never persist this
 * URL and re-mint per request.
 */
export const OEM_DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * The `files` collection document (OEM drawings/attachments). Mirrors
 * `ImageMetadataDoc`: storage-backed rows carry storage identifiers + lifecycle,
 * legacy rows carry base64 `data`. Every storage/lifecycle field is
 * server-managed — written only by dedicated OEM media actions, never generic
 * CRUD. `uploadSecretHash` is server-only and never returned to clients.
 */
export interface FileMetadataDoc {
  _id: string;
  name: string;
  mimeType: string;
  purpose: 'oem-drawing';
  storageProvider: ImageStorageProvider;
  storageMode?: ImageStorageMode;
  storageFileId?: string;
  storagePath?: string;
  byteSize?: number;
  checksumSha256?: string;
  status?: MediaStatus;
  /** Owning OEM project, set on finalization. */
  ownerProjectId?: string;
  /** Single-use upload-intent binding (server-only). */
  uploadIntentId?: string;
  uploadSecretHash?: string;
  uploadExpiresAt?: string;
  /**
   * Hash of the request source (e.g. client IP) at intent creation, used to
   * count per-source rate/pending caps. Server-only; hashed so the raw source
   * is never persisted. Absent when no trusted source signal was available.
   */
  uploadSourceHash?: string;
  /**
   * Atomic single-winner finalization claim (server-only). `submitProject`
   * increments this via `incrementField`; only the request that flips it 0→1 may
   * finalize the upload, so a concurrent double-submit/replay cannot attach the
   * same object to two projects (consume-once).
   */
  finalizeClaim?: number;
  /** Legacy base64 bytes; only when `storageProvider === 'legacy-base64'`. */
  data?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Lowercase extension (no dot) of a filename, or '' when there is none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** True if the filename's extension is an accepted OEM attachment type. */
export function isAllowedOemExtension(name: string): boolean {
  return (OEM_FILE_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/**
 * Validation for a public OEM upload-intent request. The extension must be
 * allowlisted; the declared MIME is advisory (CAD clients often send
 * `application/octet-stream`) and is cross-checked against magic bytes after
 * upload. `byteSize` is capped here; the finalization action recomputes size and
 * checksum server-side rather than trusting the client.
 */
export const oemFileUploadSchema = z
  .object({
    fileName: z.string().min(1, 'File name is required').max(300),
    mimeType: z.string().min(1).max(200),
    byteSize: z
      .number()
      .int()
      .positive()
      .max(OEM_FILE_MAX_BYTES, `File exceeds ${OEM_FILE_MAX_BYTES} bytes`),
    checksumSha256: z.string().optional(),
  })
  .refine((v) => isAllowedOemExtension(v.fileName), {
    message: 'Unsupported file type',
    path: ['fileName'],
  });
export type OemFileUploadInput = z.infer<typeof oemFileUploadSchema>;
