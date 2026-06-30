/**
 * Media object-storage facade (`@vibelingan-channel/media-storage`). Backend code
 * (cloud functions, local-server, migration scripts) imports `mediaStorage()` and
 * never touches a concrete storage backend; the active adapter is injected via
 * `setMediaStorage()` at startup — mirroring the `DbAdapter` pattern in
 * `@vibelingan-channel/db`.
 *
 * This entry (`.`) and `./local-disk` are CloudBase-free. The CloudBase backend
 * lives behind the separate `./cloudbase` entry and takes the SDK by injection,
 * so importing this package never pulls `wx-server-sdk` into a bundle (design
 * §20.4 exit criterion: no browser bundle imports the CloudBase SDK).
 *
 * See docs/IMAGE_UPLOAD_STORAGE_DESIGN.md §20.4 (MIU-02).
 */

/** Top-level storage namespaces; map to the path prefixes below. */
export type MediaNamespace = 'catalog' | 'oem' | 'marketing' | 'smoke';

export interface PutMediaObjectInput {
  namespace: MediaNamespace;
  /** Owning entity id (imageId / projectId / assetId); becomes a path segment. */
  logicalId: string;
  fileName: string;
  mimeType: string;
  content: Buffer | Uint8Array | NodeJS.ReadableStream;
}

export interface StoredMediaObject {
  storageProvider: 'cloudbase-storage' | 'local-disk';
  storageMode: 'classic-nosql-storage' | 'local-disk';
  /** Durable identifier to persist (e.g. `cloud://env.bucket/path`). */
  storageFileId: string;
  storagePath: string;
  byteSize?: number;
}

/**
 * A short-lived, single-object credential that lets the BROWSER write bytes
 * straight to storage (bypassing the function byte cap). The server mints it; the
 * browser does a raw `PUT uploadUrl` with the COS headers, then reports back so
 * the server can verify + activate. `storageFileId` is the durable id to persist.
 * See docs/IMAGE_UPLOAD_EXECUTION.md §"Upload-credential mechanism".
 */
export interface UploadCredential {
  /** Raw PUT target for the bytes. */
  uploadUrl: string;
  /** Value for the request `Authorization` header. */
  authorization: string;
  /** Value for the `X-Cos-Security-Token` header. */
  token: string;
  /** Value for the `X-Cos-Meta-Fileid` header (CloudBase object meta). */
  cosFileId: string;
  /** Durable storage id to persist on the image doc (e.g. `cloud://env.bucket/path`). */
  storageFileId: string;
}

export interface MediaStorageAdapter {
  putObject(input: PutMediaObjectInput): Promise<StoredMediaObject>;
  getObjectAsBase64(fileId: string): Promise<{ body: string; byteSize?: number }>;
  getTempUrl(fileId: string, maxAgeSeconds?: number): Promise<{ url: string; expiresAt?: string }>;
  deleteObject(fileId: string): Promise<void>;
  /**
   * Mint a pre-signed credential for a browser-direct upload to `cloudPath`
   * (server-controlled). The browser never holds a storage identity — only this
   * single-object, short-lived credential. Used by the admin createUploadIntent
   * flow (MIU-Upload).
   */
  getUploadCredential(cloudPath: string): Promise<UploadCredential>;
}

/**
 * Active adapter stored on `globalThis` (not a module variable) for the same
 * reason as the db adapter: under pnpm a package can be instantiated more than
 * once, and a module-scoped singleton would diverge per instance.
 */
const MEDIA_STORAGE_KEY = Symbol.for('@vibelingan-channel/db.media-storage');

type MediaStorageHost = { [MEDIA_STORAGE_KEY]?: MediaStorageAdapter | null };

export function setMediaStorage(next: MediaStorageAdapter): void {
  (globalThis as MediaStorageHost)[MEDIA_STORAGE_KEY] = next;
}

export function mediaStorage(): MediaStorageAdapter {
  const adapter = (globalThis as MediaStorageHost)[MEDIA_STORAGE_KEY];
  if (!adapter) {
    throw new Error(
      '@vibelingan-channel/media-storage: no media storage configured. Call setMediaStorage() at startup.',
    );
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// Server-side path generation. Storage keys are ALWAYS built server-side; the
// browser never chooses a path (design §12 security model).
// ---------------------------------------------------------------------------

export type VariantRole = 'original' | 'detail' | 'card' | 'thumb';

/**
 * Sanitize a single path segment: drop control chars and quotes, replace
 * slashes/backslashes with `_`, collapse `..` (no traversal) and whitespace,
 * trim leading/trailing dots/underscores, cap length, and never return empty.
 */
export function safeFileName(name: string): string {
  let stripped = '';
  for (const ch of name ?? '') {
    const code = ch.codePointAt(0);
    // Keep printable chars only: drop C0 controls (< 0x20) and DEL (0x7f).
    if (code !== undefined && code >= 0x20 && code !== 0x7f) stripped += ch;
  }
  const cleaned = stripped
    .normalize('NFKC')
    .replace(/["'`]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    // Truncate BEFORE the leading/trailing trim so a cut at the 120-char
    // boundary can't re-introduce a trailing `_`/`.`.
    .slice(0, 120)
    .replace(/^[._]+|[._]+$/g, '');
  return cleaned || 'file';
}

function yearMonth(now: Date): { yyyy: string; mm: string } {
  return {
    yyyy: String(now.getUTCFullYear()),
    mm: String(now.getUTCMonth() + 1).padStart(2, '0'),
  };
}

/**
 * The storage key for a `PutMediaObjectInput`. Catalog/oem/marketing are
 * date-partitioned under their owning id; smoke is a flat `smoke/<name>`.
 *   catalog/<yyyy>/<mm>/<logicalId>/<safeName>
 *   oem/<yyyy>/<mm>/<logicalId>/<safeName>
 *   marketing/<yyyy>/<mm>/<logicalId>/<safeName>
 *   smoke/<safeName>
 */
export function objectStoragePath(
  input: Pick<PutMediaObjectInput, 'namespace' | 'logicalId' | 'fileName'> & { now?: Date },
): string {
  const safe = safeFileName(input.fileName);
  if (input.namespace === 'smoke') return `smoke/${safe}`;
  const { yyyy, mm } = yearMonth(input.now ?? new Date());
  return `${input.namespace}/${yyyy}/${mm}/${safeFileName(input.logicalId)}/${safe}`;
}

/**
 * Convenience builder for a catalog image variant. Equivalent to
 * `objectStoragePath({ namespace: 'catalog', logicalId: imageId, fileName: `${role}-${fileName}` })`.
 */
export function catalogStoragePath(input: {
  imageId: string;
  role: VariantRole;
  fileName: string;
  now?: Date;
}): string {
  const { yyyy, mm } = yearMonth(input.now ?? new Date());
  return `catalog/${yyyy}/${mm}/${safeFileName(input.imageId)}/${input.role}-${safeFileName(input.fileName)}`;
}
