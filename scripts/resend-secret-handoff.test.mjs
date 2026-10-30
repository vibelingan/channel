import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { decryptHandoff, encryptTestPayload, handoffPage } from './resend-secret-handoff.mjs';
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
test('offline handoff decrypts only valid supported secrets; tampering fails', () => {
  const payload = { purpose: 'RESEND_API_KEY', secret: 're_SYNTHETIC_TEST_ONLY' };
  const encrypted = encryptTestPayload(payload, keys.publicKey);
  assert.equal(JSON.stringify(encrypted).includes(payload.secret), false);
  assert.deepEqual(decryptHandoff(encrypted, keys.privateKey), payload);
  const corrupt = Buffer.from(encrypted.data, 'base64');
  corrupt[0] ^= 1;
  assert.throws(() =>
    decryptHandoff({ ...encrypted, data: corrupt.toString('base64') }, keys.privateKey),
  );
  assert.throws(() =>
    encryptTestPayload({ purpose: 'UNEXPECTED_ENV', secret: payload.secret }, keys.publicKey),
  );
  assert.throws(() =>
    encryptTestPayload({ ...payload, secret: 're_BAD\nOTHER=1' }, keys.publicKey),
  );
});
test('owner page blocks network and contains no recipient private key', () => {
  const page = handoffPage(keys.publicKey);
  assert.ok(page.includes("connect-src 'none'"));
  assert.equal(page.includes('PRIVATE KEY'), false);
  assert.equal(page.includes('localStorage'), false);
});
