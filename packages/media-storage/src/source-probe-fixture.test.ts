import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { decodeCatalogImagePixels } from './pixels.ts';
import { sourceProbePng } from './source-probe-fixture.test-helper.ts';
test('source acceptance generates unique oversized real pixels without a business input', async () => {
  const first = await sourceProbePng('1'.repeat(32));
  const second = await sourceProbePng('2'.repeat(32));
  assert.ok(first.length > 4_500_000 && first.length < 5_000_000);
  assert.notEqual(
    createHash('sha256').update(first).digest('hex'),
    createHash('sha256').update(second).digest('hex'),
  );
  const result = await decodeCatalogImagePixels(first, 'image/png');
  assert.equal(result.status, 'decoded');
  if (result.status === 'decoded') {
    assert.equal(result.width, 1600);
    assert.equal(result.height, 1000);
  }
  await assert.rejects(sourceProbePng('../customer'));
});
