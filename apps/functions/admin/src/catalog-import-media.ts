/**
 * Fetching source images safely.
 *
 * The workbook hands us URLs a supplier controls, and the importer runs
 * server-side. That combination is a server-side request forgery primitive
 * unless every hop is checked: a URL pointing at `169.254.169.254`,
 * `127.0.0.1:6379` or an internal hostname would otherwise be fetched by our
 * own process, from inside our own network.
 *
 * So every address is resolved and inspected BEFORE the connection, redirects
 * are followed manually with the same check applied to each hop, and the
 * response is bounded by time, size and content type. Bytes that are not
 * actually a JPEG, PNG or WebP — checked by magic number, not by the
 * `Content-Type` header the supplier sent — are rejected.
 *
 * Everything here writes to the LOCAL media directory. No CloudBase
 * credential is read and no CloudBase object is created; migrating accepted
 * images into the production media lifecycle is deliberately out of scope.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { type LookupFunction, isIP } from 'node:net';
import { createDoc } from '@vibelingan-channel/db';
import { catalogStoragePath, mediaStorage } from '@vibelingan-channel/media-storage';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { Agent, fetch as undiciFetch } from 'undici';

/** No single source image may exceed this. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
/**
 * Pixel ceiling. Bytes alone are not enough: a "decompression bomb" image can
 * be a few hundred KB on the wire and 100+ megapixels once decoded, which is
 * gigabytes of RAM in whatever eventually resizes it. Dimensions are read from
 * the file header, so nothing is decoded to find out.
 */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** No single side may exceed this, even within the pixel budget. */
export const MAX_IMAGE_SIDE = 20_000;

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageMime = (typeof ALLOWED_MIME_TYPES)[number];

export type ImageFetchFailure =
  | 'not-https'
  | 'blocked-address'
  | 'unresolvable-host'
  | 'too-many-redirects'
  | 'http-error'
  | 'too-large'
  | 'timeout'
  | 'network-error'
  | 'unsupported-content'
  | 'oversized-dimensions'
  | 'undecodable-dimensions';

export interface ImageDimensions {
  width: number;
  height: number;
}

export type ImageFetchResult =
  | {
      ok: true;
      bytes: Buffer;
      mimeType: AllowedImageMime;
      sha256: string;
      finalUrl: string;
      dimensions: ImageDimensions;
    }
  | { ok: false; reason: ImageFetchFailure; detail: string };

/**
 * Reserved, private and link-local ranges. `169.254.169.254` is the cloud
 * metadata endpoint and is the single most valuable target of an SSRF, so the
 * whole link-local block is refused rather than special-cased.
 */
function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped addresses must be judged as the IPv4 they carry, in EITHER of
  // the two forms an implementation may hand back: dotted-decimal
  // (::ffff:169.254.169.254) or the equivalent two hex 16-bit groups
  // (::ffff:a9fe:a9fe is the same address) -- a check for only one form is a
  // bypass for the other.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1] !== undefined) return isBlockedIpv4(dotted[1]);
  const hexGroups = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexGroups?.[1] !== undefined && hexGroups[2] !== undefined) {
    const high = Number.parseInt(hexGroups[1], 16);
    const low = Number.parseInt(hexGroups[2], 16);
    const asIpv4 = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
    return isBlockedIpv4(asIpv4);
  }
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

/**
 * Resolve a hostname and refuse it unless EVERY address it answers with is
 * public. Checking only the first answer would let a host that returns one
 * public and one private address slip through on a retry.
 */
async function assertPublicHost(
  hostname: string,
  resolveHost: HostResolver,
): Promise<ImageFetchFailure | null> {
  // WHATWG `URL.hostname` keeps the brackets on an IPv6 literal ("[::1]"),
  // but `net.isIP`/`dns.lookup` expect the bare address. Without stripping
  // them, every literal-IPv6 URL falls through past this check entirely and
  // is reported as an unresolvable HOSTNAME instead of ever reaching the
  // address check below -- accidentally fail-closed for public IPv6 hosts
  // too, and it means the IPv6 blocklist is never actually exercised here.
  const bareHost =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const literal = isIP(bareHost);
  if (literal !== 0) return isBlockedAddress(bareHost) ? 'blocked-address' : null;
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    return 'unresolvable-host';
  }
  if (addresses.length === 0) return 'unresolvable-host';
  return addresses.some((address) => isBlockedAddress(address)) ? 'blocked-address' : null;
}

/**
 * Seams, used ONLY by tests.
 *
 * The policy this file implements cannot be exercised against a real network
 * without either reaching out to the public internet or standing up a
 * localhost server — and a localhost server is exactly what the SSRF guard is
 * built to refuse. Injecting the resolver and the fetch lets every branch
 * (redirect chains, size ceilings, magic-byte sniffing, blocked addresses) be
 * tested offline and deterministically, while the production call sites pass
 * nothing and get the real implementations.
 */
export interface ImageFetchSeams {
  resolveHost?: HostResolver;
  fetchImpl?: typeof fetch;
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolveHost: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true });
  return addresses.map((entry) => entry.address);
};

/**
 * A `dns.lookup`-compatible resolver that validates addresses AT THE MOMENT OF
 * CONNECTING, not earlier. `assertPublicHost` below resolves and checks
 * *before* the request is even built, as a fast-fail; without this, `fetch`
 * would then run its OWN, separate DNS resolution when it actually opens the
 * socket -- a window in which a short-TTL record can rebind from a public
 * answer to `127.0.0.1` or `169.254.169.254` between the two lookups.
 * Undici's connector forwards `Agent`'s `connect` options straight to
 * `net.connect`/`tls.connect`, both of which accept a `lookup` override with
 * this exact signature, so wiring one in here makes the address that gets
 * validated the same one that gets connected to -- closing the gap instead of
 * narrowing it.
 */
export function makeValidatingLookup(resolveHost: HostResolver): LookupFunction {
  return (hostname, options, callback) => {
    const wantsAll = typeof options === 'object' && options !== null && options.all === true;
    resolveHost(hostname)
      .then((addresses) => {
        const safe = addresses.filter((address) => !isBlockedAddress(address));
        if (safe.length === 0) {
          callback(new Error(`no public address for ${hostname}`), '', 0);
          return;
        }
        if (wantsAll) {
          callback(
            null,
            safe.map((address) => ({ address, family: isIP(address) })),
          );
          return;
        }
        const chosen = safe[0] as string;
        callback(null, chosen, isIP(chosen));
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error('lookup failed'), '', 0);
      });
  };
}

/** Content type by magic number. The supplier's own header is not evidence. */
export function sniffImageMime(bytes: Buffer): AllowedImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Read the pixel dimensions from a file HEADER, without decoding the image.
 *
 * This is the guard against a decompression bomb: a 300 KB PNG can declare
 * 30,000 x 30,000, which is 900 megapixels and several gigabytes once anything
 * expands it. Reading the header costs a handful of bytes and refuses the file
 * before that can happen.
 *
 * Returns `null` when the dimensions cannot be located, which is treated as a
 * rejection rather than as "probably fine".
 */
export function readImageDimensions(
  bytes: Buffer,
  mimeType: AllowedImageMime,
): ImageDimensions | null {
  if (mimeType === 'image/png') {
    // 8-byte signature, 4-byte length, "IHDR", then width and height.
    if (bytes.length < 24 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  if (mimeType === 'image/jpeg') {
    // Walk the segment chain to a start-of-frame marker.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1] as number;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) return null;
      // SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        if (offset + 9 > bytes.length) return null;
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return null;
  }

  // WebP: RIFF container, then one of three frame encodings.
  if (bytes.length < 30) return null;
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    // 24-bit little-endian canvas size, stored as (size - 1).
    const width =
      1 + (bytes[24] as number) + ((bytes[25] as number) << 8) + ((bytes[26] as number) << 16);
    const height =
      1 + (bytes[27] as number) + ((bytes[28] as number) << 8) + ((bytes[29] as number) << 16);
    return { width, height };
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits =
      (bytes[21] as number) |
      ((bytes[22] as number) << 8) |
      ((bytes[23] as number) << 16) |
      ((bytes[24] as number) << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte start code 0x9d 0x01 0x2a, then 14-bit width and height.
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

/**
 * Read the body with a running byte cap, aborting the transfer the moment it
 * is exceeded.
 *
 * `Content-Length` is a claim, not a guarantee: a hostile or broken server can
 * declare 1 KB and stream forever. Buffering the whole body first and checking
 * afterwards would mean the damage is already done, so the cap is enforced
 * chunk by chunk and the connection is dropped rather than drained.
 */
async function readBodyWithCap(
  response: Response,
  limit: number,
  controller: AbortController,
): Promise<Buffer | 'too-large'> {
  const stream = response.body;
  if (stream === null) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        controller.abort();
        return 'too-large';
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetch one source image under the full policy. Returns a reason rather than
 * throwing, because one unreachable URL must cost its own image and nothing
 * else — the import continues and the URL stays retryable.
 */
export async function fetchSourceImage(
  sourceUrl: string,
  seams: ImageFetchSeams = {},
): Promise<ImageFetchResult> {
  const resolveHost = seams.resolveHost ?? defaultResolveHost;
  // Only the real network fetch needs connection pinning -- a test's injected
  // fetchImpl never opens a socket, so there is no DNS-rebinding window to close.
  const pinnedDispatcher =
    seams.fetchImpl === undefined
      ? new Agent({ connect: { lookup: makeValidatingLookup(resolveHost) } })
      : null;
  // Node's global `fetch` is powered by an INTERNAL copy of undici baked into
  // the runtime, which enforces its own handler protocol -- driving it with a
  // dispatcher built from the separately-installed `undici` package throws
  // ("invalid onRequestStart method") because the two copies' internals don't
  // agree, even though their public types look compatible. Using `undici`'s
  // own `fetch` alongside its own `Agent` keeps both halves from the same
  // package version, which is what actually works at runtime (verified
  // against a live HTTPS host, not just by reading the types).
  const doFetch: typeof fetch =
    seams.fetchImpl ??
    ((url, init) =>
      undiciFetch(
        url as unknown as string,
        {
          ...(init as object),
          dispatcher: pinnedDispatcher ?? undefined,
        } as Parameters<typeof undiciFetch>[1],
      ) as unknown as Promise<Response>);
  let current: URL;
  try {
    current = new URL(sourceUrl);
  } catch {
    return { ok: false, reason: 'network-error', detail: 'malformed URL' };
  }

  try {
    return await fetchImage();
  } finally {
    await pinnedDispatcher?.close();
  }

  async function fetchImage(): Promise<ImageFetchResult> {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (current.protocol !== 'https:') {
        return { ok: false, reason: 'not-https', detail: `refused ${current.protocol}//` };
      }
      const blocked = await assertPublicHost(current.hostname, resolveHost);
      if (blocked !== null) {
        return { ok: false, reason: blocked, detail: `host ${current.hostname}` };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await doFetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: ALLOWED_MIME_TYPES.join(',') },
        });
      } catch (error) {
        clearTimeout(timer);
        const aborted = error instanceof Error && error.name === 'AbortError';
        return {
          ok: false,
          reason: aborted ? 'timeout' : 'network-error',
          detail: error instanceof Error ? error.message : 'fetch failed',
        };
      }
      clearTimeout(timer);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) {
          return { ok: false, reason: 'http-error', detail: `${response.status} without Location` };
        }
        if (hop === MAX_REDIRECTS) {
          return { ok: false, reason: 'too-many-redirects', detail: `${MAX_REDIRECTS} hops` };
        }
        try {
          current = new URL(location, current);
        } catch {
          return { ok: false, reason: 'network-error', detail: 'malformed redirect target' };
        }
        continue;
      }

      if (!response.ok) {
        return { ok: false, reason: 'http-error', detail: `HTTP ${response.status}` };
      }

      // The declared length is a hint that lets an obvious offender be refused
      // without transferring anything; the streamed cap below is what actually
      // enforces the ceiling.
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        controller.abort();
        return { ok: false, reason: 'too-large', detail: `${declared} bytes declared` };
      }

      const body = await readBodyWithCap(response, MAX_IMAGE_BYTES, controller);
      if (body === 'too-large') {
        return {
          ok: false,
          reason: 'too-large',
          detail: `stream exceeded ${MAX_IMAGE_BYTES} bytes and was aborted`,
        };
      }
      const bytes = body;

      // Content type comes from the bytes, never from the supplier's header, so
      // an HTML page or an SVG served as image/jpeg is refused here.
      const mimeType = sniffImageMime(bytes);
      if (mimeType === null) {
        return { ok: false, reason: 'unsupported-content', detail: 'not a JPEG, PNG or WebP' };
      }

      const dimensions = readImageDimensions(bytes, mimeType);
      if (dimensions === null) {
        return {
          ok: false,
          reason: 'undecodable-dimensions',
          detail: `${mimeType} header did not yield dimensions`,
        };
      }
      if (
        dimensions.width < 1 ||
        dimensions.height < 1 ||
        dimensions.width > MAX_IMAGE_SIDE ||
        dimensions.height > MAX_IMAGE_SIDE ||
        dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
      ) {
        return {
          ok: false,
          reason: 'oversized-dimensions',
          detail: `${dimensions.width}x${dimensions.height}`,
        };
      }

      return {
        ok: true,
        bytes,
        mimeType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        finalUrl: current.toString(),
        dimensions,
      };
    }

    return { ok: false, reason: 'too-many-redirects', detail: `${MAX_REDIRECTS} hops` };
  }
}

const EXTENSIONS: Record<AllowedImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface MigratedImage {
  imageId: string;
  sha256: string;
  reused: boolean;
}

/**
 * Store fetched bytes as an `images` record backed by the local media
 * directory.
 *
 * Deduplication is by CONTENT hash, not by URL: this workbook references 452
 * distinct URLs 1,549 times, and several of those URLs serve the same photo.
 * The caller passes a cache so one run downloads each distinct image once.
 */
export async function migrateImageLocally(
  fetched: Extract<ImageFetchResult, { ok: true }>,
  displayName: string,
  seenByHash: Map<string, string>,
): Promise<MigratedImage> {
  const existing = seenByHash.get(fetched.sha256);
  if (existing !== undefined) return { imageId: existing, sha256: fetched.sha256, reused: true };

  const fileName = `${fetched.sha256.slice(0, 16)}.${EXTENSIONS[fetched.mimeType]}`;
  // The image row is created first so its id can key the storage path, which
  // is the same order the existing catalog upload path uses.
  const doc: CollectionDoc = await createDoc('images', {
    name: displayName.slice(0, 200),
    mimeType: fetched.mimeType,
    purpose: 'catalog-image',
    status: 'pending',
    publishedRefCount: 0,
    byteSize: fetched.bytes.length,
    checksumSha256: fetched.sha256,
  });

  const stored = await mediaStorage().putObject({
    namespace: 'catalog',
    logicalId: doc._id,
    fileName,
    mimeType: fetched.mimeType,
    content: fetched.bytes,
  });

  // `updateDoc`, not `update`: every storage/lifecycle field on `images` is
  // readOnly on the generic CRUD surface by design, so only the trusted
  // server-side path may set them — the same path the upload actions use.
  const { updateDoc } = await import('@vibelingan-channel/db');
  await updateDoc('images', doc._id, {
    storageProvider: stored.storageProvider,
    storageMode: stored.storageMode,
    storageFileId: stored.storageFileId,
    storagePath:
      stored.storagePath ?? catalogStoragePath({ imageId: doc._id, role: 'original', fileName }),
    status: 'active',
  });

  seenByHash.set(fetched.sha256, doc._id);
  return { imageId: doc._id, sha256: fetched.sha256, reused: false };
}
