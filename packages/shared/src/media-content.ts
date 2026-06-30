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
 * True if the sniffed signature is consistent with a declared MIME (trimmed,
 * case-insensitive). `'unknown'` never matches — the caller must then fall back
 * to its extension allowlist or reject. A `image/jpg` alias maps to `jpeg`.
 */
export function signatureMatchesMime(sig: MediaSignature, declaredMime: string): boolean {
  if (sig === 'unknown') return false;
  const mime = declaredMime.trim().toLowerCase();
  if (sig === 'jpeg' && mime === 'image/jpg') return true; // common non-canonical alias
  return SIGNATURE_MIME[sig] === mime;
}
