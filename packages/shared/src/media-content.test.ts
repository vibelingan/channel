import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type MediaSignature,
  SIGNATURE_MIME,
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

test('unknown signature never matches any MIME', () => {
  assert.equal(signatureMatchesMime('unknown', 'application/pdf'), false);
  assert.equal(signatureMatchesMime('unknown', 'image/png'), false);
});

test('mismatched signature/MIME is rejected (declared lies)', () => {
  assert.equal(signatureMatchesMime('png', 'image/jpeg'), false);
  assert.equal(signatureMatchesMime('zip', 'application/pdf'), false);
  assert.equal(signatureMatchesMime('pdf', 'application/zip'), false);
});
