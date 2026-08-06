/**
 * SSRF-safe candidate media import (ARCHITECTURE §13, MIU 12).
 *
 * Source image URLs come from Alibaba payloads and are UNTRUSTED. Every fetch
 * is: HTTPS-only, suffix-safe host-allowlisted, DNS-resolved with
 * loopback/private/link-local/multicast/reserved rejection, redirect-validated
 * hop by hop, time-bounded, and streamed under a byte cap. Content is
 * verified by magic bytes (the MIME is DERIVED from bytes, never from
 * headers) and deduplicated by SHA-256.
 *
 * Imported candidates enter the EXISTING media lifecycle as
 * status 'active' + publishedRefCount 0 + unattached — admin-visible,
 * public-invisible ('pending' would be reaped by the 24h orphan sweep,
 * R1 M12). The fixed sentinel owner engages the reference locks; the
 * dedicated removal action below is their only delete path (R1 M13).
 */
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  acquireImageMutation,
  findByField,
  list,
  releaseImageMutation,
} from '@vibelingan-channel/db';
import { mediaStorage, objectStoragePath } from '@vibelingan-channel/media-storage';
import {
  CATALOG_IMAGE_MAX_BYTES,
  COLLECTIONS,
  SIGNATURE_MIME,
  sniffMagicBytes,
} from '@vibelingan-channel/shared';
import { createDoc, getDoc, removeDoc } from './repo.ts';

export const ALIBABA_IMAGE_IMPORT_OWNER = 'alibaba-catalog-sync';
const ALLOWED_HOST_SUFFIXES = ['alicdn.com', 'alibaba.com'];
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const IMPORTABLE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface MediaImportDeps {
  fetchImpl?: typeof fetch;
  /** Injectable resolver for tests; returns every address for the host. */
  resolveDns?: (hostname: string) => Promise<string[]>;
  now?: () => string;
}

export type MediaImportFailure =
  | 'invalid-url'
  | 'host-not-allowed'
  | 'dns-blocked'
  | 'too-many-redirects'
  | 'fetch-failed'
  | 'too-large'
  | 'bad-content'
  | 'write-failed';

export type MediaImportResult =
  | { ok: true; imageId: string; deduplicated: boolean }
  | { ok: false; reason: MediaImportFailure };

/** Loopback/private/link-local/CGN/multicast/reserved — v4 and v6. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGN 100.64/10
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 doc nets
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    return true; // link-local fe80::/10
  }
  if (lower.startsWith('ff')) return true; // multicast
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped?.[1]) return isBlockedAddress(mapped[1]);
  return false;
}

function allowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '' && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  return allowed ? url : null;
}

async function defaultResolveDns(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
}

async function readBodyCapped(response: Response): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > CATALOG_IMAGE_MAX_BYTES ? null : buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > CATALOG_IMAGE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null; // streaming cap: stop pulling bytes immediately
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

/** Import one remote candidate image; never attaches it to any product. */
export async function importCandidateImage(
  sourceUrl: string,
  deps: MediaImportDeps = {},
): Promise<MediaImportResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveDns = deps.resolveDns ?? defaultResolveDns;

  let current = allowedUrl(sourceUrl);
  if (!current) {
    return {
      ok: false,
      reason: sourceUrl.startsWith('https:') ? 'host-not-allowed' : 'invalid-url',
    };
  }

  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let addresses: string[];
    try {
      addresses = await resolveDns(current.hostname);
    } catch {
      return { ok: false, reason: 'dns-blocked' };
    }
    if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
      return { ok: false, reason: 'dns-blocked' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      response = await fetchImpl(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      return { ok: false, reason: 'fetch-failed' };
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { ok: false, reason: 'fetch-failed' };
      let nextUrl: string;
      try {
        nextUrl = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: 'invalid-url' };
      }
      // EVERY redirect target re-runs the full allowlist + DNS validation.
      const validated = allowedUrl(nextUrl);
      if (!validated) return { ok: false, reason: 'host-not-allowed' };
      current = validated;
      response = null;
      continue;
    }
    break;
  }
  if (!response) return { ok: false, reason: 'too-many-redirects' };
  if (!response.ok) return { ok: false, reason: 'fetch-failed' };

  const bytes = await readBodyCapped(response);
  if (bytes === null) return { ok: false, reason: 'too-large' };

  // MIME derives from magic bytes; header Content-Type is untrusted.
  const signature = sniffMagicBytes(bytes);
  const mimeType = signature === 'unknown' ? '' : (SIGNATURE_MIME[signature] ?? '');
  if (!IMPORTABLE_MIME.has(mimeType)) return { ok: false, reason: 'bad-content' };

  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = await findByField('images', 'checksumSha256', checksumSha256);
  if (existing) return { ok: true, imageId: existing._id, deduplicated: true };

  const now = deps.now?.() ?? new Date().toISOString();
  const logicalId = randomUUID();
  const fileName = `alibaba-${checksumSha256.slice(0, 12)}.${mimeType.split('/')[1]}`;
  try {
    const stored = await mediaStorage().putObject({
      namespace: 'catalog',
      logicalId,
      fileName,
      mimeType,
      content: bytes,
    });
    try {
      const doc = await createDoc('images', {
        name: fileName,
        mimeType,
        purpose: 'catalog-image',
        storageProvider: stored.storageProvider,
        storageMode: stored.storageMode,
        storagePath: objectStoragePath({ namespace: 'catalog', logicalId, fileName }),
        storageFileId: stored.storageFileId,
        status: 'active',
        publishedRefCount: 0,
        uploadedByUserId: ALIBABA_IMAGE_IMPORT_OWNER,
        byteSize: bytes.byteLength,
        checksumSha256,
        createdAt: now,
        updatedAt: now,
      });
      return { ok: true, imageId: doc._id, deduplicated: false };
    } catch (docError) {
      // Compensation order: object first, then (missing) doc — never leak.
      await mediaStorage()
        .deleteObject(stored.storageFileId)
        .catch((e) =>
          console.error('[alibaba-catalog-sync] import compensation delete failed:', e),
        );
      console.error('[alibaba-catalog-sync] import doc write failed:', docError);
      return { ok: false, reason: 'write-failed' };
    }
  } catch (storageError) {
    console.error('[alibaba-catalog-sync] import storage write failed:', storageError);
    return { ok: false, reason: 'write-failed' };
  }
}

export type RemoveImportResult =
  | { ok: true; imageId: string }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'not-imported'
        | 'not-active'
        | 'busy'
        | 'still-referenced'
        | 'delete-failed';
    };

const REFERENCE_SCAN_PAGE_SIZE = 100;

/**
 * Any registered document (published or NOT — publishedRefCount only counts
 * published refs) still holding the image in `imageIds` blocks removal; an
 * unpublished draft would otherwise dangle. Cursor-paginated by `_id` for the
 * same never-skip guarantee as the admin function's reference scan.
 */
async function findCandidateReference(
  imageId: string,
): Promise<{ collection: string; documentId: string } | null> {
  const collections = COLLECTIONS.filter((definition) =>
    definition.fields.some((field) => field.name === 'imageIds'),
  );
  for (const definition of collections) {
    let cursor = '';
    for (;;) {
      const result = await list({
        collection: definition.name,
        page: 1,
        pageSize: REFERENCE_SCAN_PAGE_SIZE,
        search: '',
        sort: [{ field: '_id', dir: 'asc' as const }],
        ...(cursor
          ? {
              filter: {
                combinator: 'and' as const,
                clauses: [{ field: '_id', op: 'gt' as const, value: cursor }],
              },
            }
          : {}),
      });
      for (const document of result.items) {
        if (
          Array.isArray(document.imageIds) &&
          document.imageIds.some(
            (candidate) => typeof candidate === 'string' && candidate.trim() === imageId,
          )
        ) {
          return { collection: definition.name, documentId: String(document._id) };
        }
      }
      const last = result.items.at(-1);
      if (result.items.length < REFERENCE_SCAN_PAGE_SIZE || last === undefined) break;
      cursor = String(last._id);
    }
  }
  return null;
}

/**
 * Admin-only removal of an UNREFERENCED imported candidate — the sentinel
 * owner means no admin's own uploader-identity delete path can ever match
 * (R1 M13). Mirrors abandonUpload's lifecycle discipline (review R2 #1):
 * mutation lock, re-read under the lock, full reference scan, and a storage
 * delete failure is TERMINAL — the doc survives so the object is never
 * orphaned. Object first, then the doc.
 */
export async function removeImportedCandidate(imageId: string): Promise<RemoveImportResult> {
  const image = await getDoc('images', imageId);
  if (!image) return { ok: false, reason: 'not-found' };
  if (image.uploadedByUserId !== ALIBABA_IMAGE_IMPORT_OWNER) {
    return { ok: false, reason: 'not-imported' };
  }
  if (image.status !== 'active') return { ok: false, reason: 'not-active' };

  const owner = randomUUID();
  const lock = await acquireImageMutation(imageId, owner, new Date().toISOString());
  if (lock === 'missing') return { ok: false, reason: 'not-found' };
  if (lock !== 'acquired') return { ok: false, reason: 'busy' };
  let deleted = false;
  try {
    // Re-read under the lock: the pre-read raced other mutations.
    const current = await getDoc('images', imageId);
    if (!current) return { ok: false, reason: 'not-found' };
    if (current.uploadedByUserId !== ALIBABA_IMAGE_IMPORT_OWNER) {
      return { ok: false, reason: 'not-imported' };
    }
    if (current.status !== 'active') return { ok: false, reason: 'not-active' };
    if (
      typeof current.publishedRefCount !== 'number' ||
      !Number.isFinite(current.publishedRefCount) ||
      current.publishedRefCount !== 0
    ) {
      return { ok: false, reason: 'still-referenced' };
    }
    const reference = await findCandidateReference(imageId);
    if (reference) return { ok: false, reason: 'still-referenced' };

    const storageFileId =
      typeof current.storageFileId === 'string' ? current.storageFileId.trim() : '';
    if (storageFileId) {
      try {
        await mediaStorage().deleteObject(storageFileId);
      } catch (error) {
        console.error('[alibaba-catalog-sync] imported-candidate object delete failed:', error);
        return { ok: false, reason: 'delete-failed' };
      }
    }
    await removeDoc('images', imageId);
    deleted = true;
    return { ok: true, imageId };
  } finally {
    if (!deleted) {
      await releaseImageMutation(imageId, owner).catch((e) =>
        console.error('[alibaba-catalog-sync] imported-candidate lock release failed:', e),
      );
    }
  }
}
