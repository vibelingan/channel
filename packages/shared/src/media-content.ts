/**
 * Media content sniffing — identify a file by its leading "magic bytes" rather
 * than trusting the client-declared MIME or extension. Used by the upload
 * verification paths (image light-signature check + OEM ZIP/PDF sniff — design
 * §12, §20.10, §25-6, §27.2-3). Pure and dependency-free.
 *
 * Sniffing is necessary but not sufficient: CAD formats (step/stp/igs/dwg/dxf …)
 * have no reliable universal signature and stay EXTENSION-gated per the design,
 * so this module reports `unknown` for them rather than guessing. Callers decide
 * whether a declared extension is allowed to stand on its own.
 *
 * See docs/IMAGE_UPLOAD_STORAGE_DESIGN.md §20.10 and docs/IMAGE_UPLOAD_EXECUTION.md.
 */

export type MediaSignature = 'png' | 'jpeg' | 'webp' | 'gif' | 'pdf' | 'zip' | 'rar' | 'unknown';

/** Canonical MIME for each byte-identifiable signature. */
export const SIGNATURE_MIME: Readonly<Record<Exclude<MediaSignature, 'unknown'>, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
};

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/**
 * Identify a file from its leading bytes. Returns `'unknown'` when no supported
 * signature matches (e.g. CAD, plain text, truncated input). Does not treat one
 * image type as another — each signature is exact.
 */
export function sniffMagicBytes(bytes: Uint8Array): MediaSignature {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  // GIF: "GIF8" (87a / 89a)
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  // PDF: "%PDF-"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  // RAR: "Rar!\x1A\x07"
  if (startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
  // WebP: "RIFF" .... "WEBP" (4-byte size at offset 4, format tag at offset 8)
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'webp';
  }
  // ZIP family (also OOXML/jar/…): local "PK\x03\x04", empty "PK\x05\x06", spanned "PK\x07\x08"
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'zip';
  }
  return 'unknown';
}

/**
 * MIME values a caller may legitimately DECLARE for each signature. Browsers and
 * upload clients report non-canonical archive/image MIME types, so a declared-vs-
 * actual check must accept known aliases — not just the canonical `SIGNATURE_MIME`
 * value — or valid OEM ZIP/RAR uploads get falsely rejected (Codex review,
 * `b43217b`). `application/octet-stream` is deliberately NOT here: a caller that
 * wants to accept octet-stream (e.g. CAD with no reliable signature) must gate it
 * separately by purpose + extension, never via byte signature alone.
 */
const ACCEPTED_MIME: Readonly<Record<Exclude<MediaSignature, 'unknown'>, readonly string[]>> = {
  png: ['image/png'],
  jpeg: ['image/jpeg', 'image/jpg'],
  webp: ['image/webp'],
  gif: ['image/gif'],
  pdf: ['application/pdf'],
  zip: [
    'application/zip',
    'application/x-zip-compressed',
    'application/x-zip',
    'application/zip-compressed',
  ],
  rar: ['application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar'],
};

/**
 * True if a client-declared MIME is consistent with the sniffed signature,
 * accepting common non-canonical aliases (trimmed, case-insensitive). `'unknown'`
 * never matches — the caller must then fall back to its extension allowlist or
 * reject. Use `SIGNATURE_MIME` (not this) to choose the response `Content-Type`.
 */
export function signatureMatchesMime(sig: MediaSignature, declaredMime: string): boolean {
  if (sig === 'unknown') return false;
  return ACCEPTED_MIME[sig].includes(declaredMime.trim().toLowerCase());
}

/**
 * Sanitize a client-supplied filename for safe use in a `Content-Disposition`
 * header and as a stored display name. Removes CR/LF (header injection), quotes
 * (breaks the header token), path separators (traversal), and control chars;
 * strips leading dots/space so a name cannot become hidden or `..`; caps length
 * and falls back when nothing safe remains.
 *
 * Design §20.10 / §25-5: OEM downloads must always be served as `attachment`
 * with a sanitized name. This is necessary but not the whole story — the caller
 * must still quote or RFC 5987-encode the header value.
 */
export function sanitizeDownloadFilename(name: string, fallback = 'download'): string {
  const cleaned = name
    .replace(/[\r\n"'\\/]/g, '') // CR, LF, quotes, path separators
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') // C0 + DEL + bidi/RTL spoof chars
    .replace(/^[.\s]+/, '') // leading dots/space → never hidden or ".."
    .trim()
    .slice(0, 255)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}
