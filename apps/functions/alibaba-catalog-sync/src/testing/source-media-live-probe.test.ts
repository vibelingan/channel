import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assertSourceProbeImage,
  authorizeSourceMediaProbe,
  main,
} from './source-media-live-probe.ts';
const token = '1'.repeat(64);
const env = {
  TCB_ENV: 'diversity-123-d9grnqfux221323bb',
  SOURCE_MEDIA_PROBE_RUN: '2'.repeat(32),
  SOURCE_MEDIA_PROBE_SHA: '3'.repeat(40),
  SOURCE_MEDIA_PROBE_DIGEST: createHash('sha256').update(token).digest('hex'),
  SOURCE_MEDIA_PROBE_EXPIRES: '2099-01-01T00:00:00.000Z',
};
test('probe refuses wrong target, credential, action and expired writes before SDK access', async () => {
  const scope = authorizeSourceMediaProbe({ action: 'run', token }, env);
  assert.equal(
    scope.sourceUrl,
    `https://sc04.alicdn.com/channel-seo-acceptance/${'2'.repeat(32)}.png`,
  );
  assert.throws(() =>
    authorizeSourceMediaProbe({ action: 'run', token }, { ...env, TCB_ENV: 'other' }),
  );
  assert.throws(() => authorizeSourceMediaProbe({ action: 'run', token: '4'.repeat(64) }, env));
  assert.throws(() => authorizeSourceMediaProbe({ action: 'publish', token }, env));
  const expired = { ...env, SOURCE_MEDIA_PROBE_EXPIRES: '2000-01-01T00:00:00.000Z' };
  assert.throws(() => authorizeSourceMediaProbe({ action: 'run', token }, expired));
  assert.equal(authorizeSourceMediaProbe({ action: 'cleanup', token }, expired).action, 'cleanup');
  await assert.rejects(main({ action: 'run', token }), /Wrong source probe environment/);
});
test('probe cleanup refuses foreign source, owner, reference or image claim', () => {
  const sourceUrl = authorizeSourceMediaProbe({ action: 'run', token }, env).sourceUrl;
  const id = '12345678-1234-4123-8123-123456789abc';
  const image = {
    _id: id,
    uploadedByUserId: 'alibaba-catalog-sync',
    publishedRefCount: 0,
    sourceMediaImport: { sourceUrl, imageId: id },
  };
  assertSourceProbeImage(image, sourceUrl);
  for (const patch of [
    { uploadedByUserId: 'customer' },
    { publishedRefCount: 1 },
    { sourceMediaImport: { sourceUrl: 'https://sc04.alicdn.com/customer.png', imageId: id } },
    { sourceMediaImport: { sourceUrl, imageId: 'foreign' } },
  ])
    assert.throws(() => assertSourceProbeImage({ ...image, ...patch }, sourceUrl));
});
