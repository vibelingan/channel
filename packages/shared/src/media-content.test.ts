import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type MediaSignature,
  SIGNATURE_MIME,
  sanitizeDownloadFilename,
  signatureMatchesMime,
  sniffMagicBytes,
} from './media-content.ts';

const bytes = (...n: number[]) => Uint8Array.from(n);
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

// --- sniffMagicBytes --------------------------------------------------------

test('detects PNG', () => {
  assert.equal(sniffMagicBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)), 'png');
});

test('detects JPEG', () => {
  assert.equal(sniffMagicBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0)), 'jpeg');
});

test('detects GIF (87a and 89a)', () => {
  assert.equal(sniffMagicBytes(ascii('GIF87a...')), 'gif');
  assert.equal(sniffMagicBytes(ascii('GIF89a...')), 'gif');
});

test('detects PDF', () => {
  assert.equal(sniffMagicBytes(ascii('%PDF-1.7\n...')), 'pdf');
});

test('detects RAR', () => {
  assert.equal(sniffMagicBytes(bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00)), 'rar');
});

test('detects WebP (RIFF....WEBP)', () => {
  // RIFF + 4-byte size + WEBP + VP8 chunk tag
  const buf = Uint8Array.from([...ascii('RIFF'), 0x10, 0, 0, 0, ...ascii('WEBPVP8 ')]);
  assert.equal(sniffMagicBytes(buf), 'webp');
});

test('RIFF container that is not WebP (e.g. WAVE) is unknown, not webp', () => {
  const wav = Uint8Array.from([...ascii('RIFF'), 0x10, 0, 0, 0, ...ascii('WAVE')]);
  assert.equal(sniffMagicBytes(wav), 'unknown');
});

test('detects ZIP local/empty/spanned headers', () => {
  assert.equal(sniffMagicBytes(bytes(0x50, 0x4b, 0x03, 0x04, 0)), 'zip');
  assert.equal(sniffMagicBytes(bytes(0x50, 0x4b, 0x05, 0x06, 0)), 'zip');
  assert.equal(sniffMagicBytes(bytes(0x50, 0x4b, 0x07, 0x08, 0)), 'zip');
});

test('CAD/text/empty/truncated inputs are unknown', () => {
  assert.equal(sniffMagicBytes(ascii('ISO-10303-21;')), 'unknown'); // STEP CAD
  assert.equal(sniffMagicBytes(ascii('hello world')), 'unknown');
  assert.equal(sniffMagicBytes(bytes()), 'unknown');
  assert.equal(sniffMagicBytes(bytes(0x89, 0x50)), 'unknown'); // truncated PNG prefix
});

test('works on a Node Buffer (Uint8Array subclass)', () => {
  assert.equal(sniffMagicBytes(Buffer.from('%PDF-1.4 ')), 'pdf');
});

// --- signatureMatchesMime ---------------------------------------------------

test('exact signature/MIME pairs match', () => {
  for (const [sig, mime] of Object.entries(SIGNATURE_MIME)) {
    assert.equal(signatureMatchesMime(sig as MediaSignature, mime), true);
  }
});

test('MIME comparison is trimmed and case-insensitive', () => {
  assert.equal(signatureMatchesMime('png', '  IMAGE/PNG '), true);
  assert.equal(signatureMatchesMime('pdf', 'Application/PDF'), true);
});

test('image/jpg alias matches a jpeg signature', () => {
  assert.equal(signatureMatchesMime('jpeg', 'image/jpg'), true);
  assert.equal(signatureMatchesMime('jpeg', 'image/jpeg'), true);
});

test('accepts common archive MIME aliases (clients report ZIP/RAR inconsistently)', () => {
  for (const m of [
    'application/zip',
    'application/x-zip-compressed',
    'application/x-zip',
    'application/zip-compressed',
    'APPLICATION/X-ZIP-COMPRESSED', // case-insensitive
  ]) {
    assert.equal(signatureMatchesMime('zip', m), true);
  }
  for (const m of ['application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar']) {
    assert.equal(signatureMatchesMime('rar', m), true);
  }
});

test('octet-stream is NOT accepted via signature alone (CAD gated separately)', () => {
  assert.equal(signatureMatchesMime('zip', 'application/octet-stream'), false);
  assert.equal(signatureMatchesMime('pdf', 'application/octet-stream'), false);
  assert.equal(signatureMatchesMime('png', 'application/octet-stream'), false);
});

test('unknown signature never matches any MIME', () => {
  assert.equal(signatureMatchesMime('unknown', 'application/pdf'), false);
  assert.equal(signatureMatchesMime('unknown', 'image/png'), false);
});

test('mismatched signature/MIME is rejected (declared lies)', () => {
  assert.equal(signatureMatchesMime('png', 'image/jpeg'), false);
  assert.equal(signatureMatchesMime('zip', 'application/pdf'), false);
  assert.equal(signatureMatchesMime('pdf', 'application/zip'), false);
});

// --- sanitizeDownloadFilename -----------------------------------------------

test('strips CR/LF (header injection) and quotes', () => {
  assert.equal(sanitizeDownloadFilename('a\r\nb.pdf'), 'ab.pdf');
  assert.equal(sanitizeDownloadFilename(`a"b'c.pdf`), 'abc.pdf');
});

test('strips path separators and leading dots (no traversal/hidden names)', () => {
  assert.equal(sanitizeDownloadFilename('../../etc/passwd'), 'etcpasswd');
  assert.equal(sanitizeDownloadFilename('...hidden.txt'), 'hidden.txt');
  assert.equal(sanitizeDownloadFilename('a\\b/c.zip'), 'abc.zip');
});

test('strips control characters', () => {
  assert.equal(sanitizeDownloadFilename('a\u0000\u001f\u007fb.zip'), 'ab.zip');
});

test('strips Unicode bidi/RTL-override spoof characters', () => {
  // U+202E would visually flip "...fdp.exe" to look like "...exe.pdf"
  assert.equal(sanitizeDownloadFilename('invoice\u202egpj.exe'), 'invoicegpj.exe');
  assert.equal(sanitizeDownloadFilename('a\u200e\u2066b.pdf'), 'ab.pdf');
});

test('falls back when nothing safe remains', () => {
  assert.equal(sanitizeDownloadFilename(''), 'download');
  assert.equal(sanitizeDownloadFilename('   '), 'download');
  assert.equal(sanitizeDownloadFilename('..'), 'download');
  assert.equal(sanitizeDownloadFilename('', 'oem-file'), 'oem-file');
});

test('preserves a normal unicode filename and caps length at 255', () => {
  assert.equal(sanitizeDownloadFilename('Drawing v2 (final).pdf'), 'Drawing v2 (final).pdf');
  assert.equal(sanitizeDownloadFilename('résumé.pdf'), 'résumé.pdf');
  assert.equal(sanitizeDownloadFilename('x'.repeat(300)).length, 255);
});
