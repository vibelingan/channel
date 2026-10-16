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
 * Each copy owns a durable pending image and URL claim before uploading.
 * A confirmed copy atomically becomes active with its URL binding, still
 * unattached with publishedRefCount 0. Cleanup must quarantine a pending
 * copy through the same state machine before deleting any bytes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  SOURCE_MEDIA_IMPORT_LEASE_MS,
  SOURCE_MEDIA_IMPORT_OWNER,
  type SourceMediaImportCommand,
  type SourceMediaImportResult,
  type SourceMediaTarget,
  SourceMediaTargetSchema,
  acquireImageMutation,
  executeImageDeletion,
  list,
  manageImageDeletion,
  manageSourceMediaImport,
  preparationUsingImage,
  readImageMutationState,
  releaseImageMutation,
  unfinishedApprovalUsingImage,
} from '@vibelingan-channel/db';
import { mediaStorage } from '@vibelingan-channel/media-storage';
import {
  CATALOG_IMAGE_MAX_BYTES,
  COLLECTIONS,
  SIGNATURE_MIME,
  alibabaPhotoSource,
  catalogReferencedImageIds,
  sniffMagicBytes,
} from '@vibelingan-channel/shared';
import { getDoc } from './repo.ts';

export const ALIBABA_IMAGE_IMPORT_OWNER = SOURCE_MEDIA_IMPORT_OWNER;
const ALLOWED_HOST_SUFFIXES = ['alicdn.com', 'alibaba.com'];
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const IMPORTABLE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export interface MediaImportDeps {
  /** Backend-only repository callback; every phase retains the caller's current lease. */
  persistImport?: (command: SourceMediaImportCommand) => Promise<SourceMediaImportResult>;
  fetchImpl?: typeof fetch;
  /** How long the photo body may take after its headers (default 15 s). */
  bodyTimeoutMs?: number;
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
  /** The photo is gone at Alibaba (404/410): trying again cannot help. */
  | 'not-found'
  | 'too-large'
  | 'bad-content'
  | 'write-failed'
  | 'busy';

export type MediaImportResult =
  | { ok: true; imageId: string; deduplicated: boolean }
  | { ok: false; reason: MediaImportFailure; failureRecorded?: true };

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

async function readBodyCapped(
  response: Response,
  timeoutMs: number,
): Promise<Buffer | null | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  const withinDeadline = async <T>(work: Promise<T>): Promise<T | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  const reader = response.body?.getReader();
  if (!reader) {
    const body = await withinDeadline(response.arrayBuffer());
    if (body === 'timeout') return 'timeout';
    const buffer = Buffer.from(body);
    return buffer.byteLength > CATALOG_IMAGE_MAX_BYTES ? null : buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // A photo that stalls mid-download must not hold the copy job (PT-G).
    const read = await withinDeadline(reader.read());
    if (read === 'timeout') {
      await reader.cancel().catch(() => {});
      return 'timeout';
    }
    const { done, value } = read;
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

type FetchCandidateResult =
  | { ok: true; bytes: Buffer; mimeType: string }
  | { ok: false; reason: Exclude<MediaImportFailure, 'busy'> };
async function fetchCandidate(
  sourceUrl: string,
  deps: MediaImportDeps,
): Promise<FetchCandidateResult> {
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
  // Alibaba's image server answers 403 for a photo it no longer serves, like
  // 404/410; retrying cannot bring it back (measured 2026-10-09).
  if (!response.ok)
    return {
      ok: false,
      reason: [403, 404, 410].includes(response.status) ? 'not-found' : 'fetch-failed',
    };

  const bytes = await readBodyCapped(response, deps.bodyTimeoutMs ?? FETCH_TIMEOUT_MS);
  if (bytes === 'timeout') return { ok: false, reason: 'fetch-failed' };
  if (bytes === null) return { ok: false, reason: 'too-large' };

  // MIME derives from magic bytes; header Content-Type is untrusted.
  const signature = sniffMagicBytes(bytes);
  const mimeType = signature === 'unknown' ? '' : (SIGNATURE_MIME[signature] ?? '');
  if (!IMPORTABLE_MIME.has(mimeType)) return { ok: false, reason: 'bad-content' };

  return { ok: true, bytes, mimeType };
}

/** Repeat the same idempotent operation once after an unknown database ACK. */
async function persistImport(
  command: SourceMediaImportCommand,
  persist = manageSourceMediaImport,
): Promise<SourceMediaImportResult> {
  try {
    return await persist(command);
  } catch {
    return persist(command);
  }
}

/** Import one remote candidate image; never attaches it to any product. */
export async function importCandidateImage(
  rawSourceUrl: string,
  deps: MediaImportDeps = {},
): Promise<MediaImportResult> {
  const validated = allowedUrl(rawSourceUrl);
  const sourceUrl = validated ? alibabaPhotoSource(rawSourceUrl) : undefined;
  if (!sourceUrl)
    return {
      ok: false,
      reason: rawSourceUrl.toLowerCase().startsWith('https:') ? 'host-not-allowed' : 'invalid-url',
    };
  const persist = (command: SourceMediaImportCommand) => persistImport(command, deps.persistImport);
  const operationId = randomUUID();
  const imageId = randomUUID();
  const now = () => deps.now?.() ?? new Date().toISOString();
  const base = { sourceUrl, operationId, imageId };
  const fail = async (reason: Exclude<MediaImportFailure, 'busy'>): Promise<MediaImportResult> => {
    try {
      const result = await persist({ ...base, action: 'fail', reason, now: now() });
      if (result.status === 'ready')
        return { ok: true, imageId: result.imageId, deduplicated: result.deduplicated };
      return result.status === 'failed'
        ? { ok: false, reason, failureRecorded: true }
        : { ok: false, reason: 'write-failed' };
    } catch {
      return { ok: false, reason: 'write-failed' };
    }
  };
  try {
    const claimed = await persist({ ...base, action: 'claim', now: now() });
    if (claimed.status === 'ready')
      return { ok: true, imageId: claimed.imageId, deduplicated: true };
    if (claimed.status !== 'claimed')
      return { ok: false, reason: claimed.status === 'busy' ? 'busy' : 'write-failed' };
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
  let fetched: FetchCandidateResult;
  try {
    fetched = await fetchCandidate(sourceUrl, deps);
  } catch {
    return fail('fetch-failed');
  }
  if (!fetched.ok) return fail(fetched.reason);
  const { bytes, mimeType } = fetched;
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  try {
    const existing = (
      await list({
        collection: 'images',
        page: 1,
        pageSize: 1,
        search: '',
        filter: {
          combinator: 'and',
          clauses: [
            { field: 'checksumSha256', op: 'eq', value: checksumSha256 },
            { field: 'status', op: 'eq', value: 'active' },
          ],
        },
      })
    ).items[0];
    if (existing?.status === 'active') {
      let acquired: boolean;
      try {
        acquired = (await acquireImageMutation(existing._id, operationId, now())) === 'acquired';
      } catch {
        const reread = await getDoc('images', existing._id);
        const lock = reread ? readImageMutationState(reread) : null;
        acquired = lock?.state === 'owned' && lock.owner === operationId;
      }
      if (!acquired) {
        await fail('write-failed');
        return { ok: false, reason: 'busy' };
      }
      try {
        const reused = await persist({
          ...base,
          action: 'reuse',
          existingImageId: existing._id,
          checksumSha256,
          now: now(),
        });
        if (reused.status === 'ready')
          return { ok: true, imageId: reused.imageId, deduplicated: true };
        if (reused.status === 'busy') {
          await fail('write-failed');
          return { ok: false, reason: 'busy' };
        }
      } finally {
        await releaseImageMutation(existing._id, operationId)
          .catch(() => releaseImageMutation(existing._id, operationId))
          .catch(() => {});
      }
    }
    const name = `alibaba-${checksumSha256.slice(0, 12)}.${mimeType.split('/')[1]}`;
    let checkpoint: SourceMediaTarget | undefined;
    const stored = await mediaStorage().putObject(
      { namespace: 'catalog', logicalId: imageId, fileName: name, mimeType, content: bytes },
      {
        beforeWrite: async (target) => {
          const startedAt = now();
          const intended = SourceMediaTargetSchema.parse({
            ...target,
            name,
            mimeType,
            checksumSha256,
            byteSize: bytes.byteLength,
          });
          const saved = await persist({
            ...base,
            action: 'checkpoint',
            target: intended,
            now: startedAt,
          });
          if (saved.status !== 'checkpointed')
            throw new Error('Source image checkpoint was not confirmed');
          // Leave at least one complete raw-PUT deadline inside the claim lease.
          // A delayed DB response must not start bytes after cleanup may take over.
          if (Date.parse(now()) - Date.parse(startedAt) >= SOURCE_MEDIA_IMPORT_LEASE_MS - 60_000)
            throw new Error('Source image checkpoint expired before upload');
          checkpoint = intended;
        },
      },
    );
    const returned = SourceMediaTargetSchema.parse({
      ...stored,
      name,
      mimeType,
      checksumSha256,
      byteSize: bytes.byteLength,
    });
    if (!checkpoint || !isDeepStrictEqual(checkpoint, returned)) return fail('write-failed');
    const committed = await persist({
      ...base,
      action: 'activate',
      target: checkpoint,
      now: now(),
    });
    if (committed.status === 'ready')
      return { ok: true, imageId: committed.imageId, deduplicated: committed.deduplicated };
    return fail('write-failed');
  } catch {
    // A failed/unknown upload or DB ACK retains the exact pending target.
    // Never destroy bytes that an activation may already have committed.
    return fail('write-failed');
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
        if (catalogReferencedImageIds(document).includes(imageId)) {
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
 * quarantine is durable before deleting bytes. Failures retain the original
 * storage targets for retry; the row is removed only after storage confirms.
 */
export async function removeImportedCandidate(imageId: string): Promise<RemoveImportResult> {
  const image = await getDoc('images', imageId);
  if (!image) return { ok: false, reason: 'not-found' };
  if (image.uploadedByUserId !== ALIBABA_IMAGE_IMPORT_OWNER) {
    return { ok: false, reason: 'not-imported' };
  }
  if (image.status !== 'active' && image.status !== 'deleted')
    return { ok: false, reason: 'not-active' };

  const owner = randomUUID();
  const lock =
    image.status === 'deleted'
      ? 'acquired'
      : await acquireImageMutation(imageId, owner, new Date().toISOString());
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
    if (current.status !== 'active' && current.status !== 'deleted')
      return { ok: false, reason: 'not-active' };
    if (current.status === 'active') {
      if (
        typeof current.publishedRefCount !== 'number' ||
        !Number.isFinite(current.publishedRefCount) ||
        current.publishedRefCount !== 0
      ) {
        return { ok: false, reason: 'still-referenced' };
      }
      // Approval reads shared photos without writing them (DEC-21): an
      // unfinished approval that would publish this photo still uses it. Jobs
      // first, references second: a job that finishes in between has recorded
      // its product (same transaction) before the reference scan reads it.
      if (await preparationUsingImage(imageId)) return { ok: false, reason: 'still-referenced' };
      if (await unfinishedApprovalUsingImage(imageId))
        return { ok: false, reason: 'still-referenced' };
      const reference = await findCandidateReference(imageId);
      if (reference) return { ok: false, reason: 'still-referenced' };
    }
    const result = await executeImageDeletion(
      {
        manage: manageImageDeletion,
        get: (id) => getDoc('images', id),
      },
      {
        action: 'begin',
        imageId,
        uploadedByUserId: ALIBABA_IMAGE_IMPORT_OWNER,
        owner,
        startedAt: new Date().toISOString(),
      },
      (fileId) => mediaStorage().deleteObject(fileId),
    );
    if (result !== 'deleted')
      return { ok: false, reason: result === 'missing' ? 'not-found' : 'delete-failed' };
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
