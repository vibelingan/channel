import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setAdapter } from '@vibelingan-channel/db';
import { handlePublicApiEvent } from '../../functions/public-api/src/http-adapter.ts';
import { JsonFileAdapter } from './json-adapter.ts';
function fixture(
  t: { after(fn: () => void): void },
  managed: 'empty' | 'corrupt' | 'absent' = 'empty',
  count = 1,
) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-image-ordinary-delete-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      images: [
        {
          _id: 'image',
          uploadedByUserId: 'u',
          name: 'original',
          status: 'active',
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          publishedRefCount: count,
          ...(managed === 'absent'
            ? {}
            : {
                catalogPublishedReferenceLedger:
                  managed === 'corrupt'
                    ? null
                    : { version: 'catalog-image-reference-ledger-v1', epoch: 4, pending: [] },
              }),
        },
      ],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  return { file, adapter, bytes: () => readFileSync(file, 'utf8') };
}
for (const method of ['remove', 'conditional-remove'] as const)
  for (const ledger of ['empty', 'corrupt'] as const)
    for (const count of [0, 1])
      test(`ordinary ${method} cannot delete ${ledger} managed image with base ${count}`, async (t) => {
        const h = fixture(t, ledger, count);
        const before = h.bytes();
        await assert.rejects(
          method === 'remove'
            ? h.adapter.remove('images', 'image')
            : h.adapter.removeDocIfFieldEquals('images', 'image', 'name', 'original'),
        );
        assert.equal(h.bytes(), before);
        assert.ok(await h.adapter.get('images', 'image'));
      });
test('refused ordinary image removal leaves public delivery available', async (t) => {
  const h = fixture(t);
  const read = () =>
    handlePublicApiEvent(
      { httpMethod: 'GET', path: '/api/images/image' },
      { jwtSecret: 'ordinary-delete-fixture' },
    );
  const before = await read();
  assert.equal(before.statusCode, 200);
  await assert.rejects(h.adapter.remove('images', 'image'));
  const after = await read();
  assert.equal(after.statusCode, 200);
  assert.equal(after.body, before.body);
});
test('ordinary missing and unmatched managed removals remain no-ops', async (t) => {
  const h = fixture(t);
  const before = h.bytes();
  assert.equal(await h.adapter.remove('images', 'missing'), false);
  assert.equal(
    await h.adapter.removeDocIfFieldEquals('images', 'missing', 'name', 'original'),
    false,
  );
  assert.equal(
    await h.adapter.removeDocIfFieldEquals('images', 'image', 'name', 'different'),
    false,
  );
  assert.equal(h.bytes(), before);
});
for (const method of ['remove', 'conditional-remove'] as const)
  test(`ordinary legacy ${method} keeps its existing trusted-call behavior`, async (t) => {
    const h = fixture(t, 'absent', 0);
    assert.equal(
      method === 'remove'
        ? await h.adapter.remove('images', 'image')
        : await h.adapter.removeDocIfFieldEquals('images', 'image', 'name', 'original'),
      true,
    );
    assert.equal(await h.adapter.get('images', 'image'), null);
  });
for (const field of [
  'catalogPublishedReferenceLedger',
  'catalogPublishedReferenceLedger.epoch',
  'catalogPublishedReferenceLedger[0]',
  'publishedRefCount.value',
  '$set',
])
  test(`ordinary image increment refuses protected path ${field}`, async (t) => {
    const h = fixture(t);
    const before = h.bytes();
    await assert.rejects(h.adapter.incrementField('images', 'image', field, 1));
    assert.equal(h.bytes(), before);
  });
test('ordinary image metadata counters and dedicated publication decrement remain usable', async (t) => {
  const h = fixture(t);
  assert.equal(await h.adapter.incrementField('images', 'image', 'downloadCount', 1), 1);
  assert.equal(await h.adapter.incrementField('images', 'image', 'publishedRefCount', -1), 0);
  assert.equal((await h.adapter.get('images', 'image'))?.publishedRefCount, 0);
});
test('managed images still finish through the existing durable deletion operation', async (t) => {
  const h = fixture(t, 'empty', 0);
  const now = '2026-10-18T00:00:00.000Z';
  assert.equal(await h.adapter.acquireImageMutation('image', 'delete-owner', now), 'acquired');
  const quarantined = await h.adapter.manageImageDeletion({
    action: 'begin',
    imageId: 'image',
    uploadedByUserId: 'u',
    owner: 'delete-owner',
    startedAt: now,
  });
  assert.equal(quarantined.status, 'ready');
  const finished = await h.adapter.manageImageDeletion({
    action: 'finish',
    imageId: 'image',
    uploadedByUserId: 'u',
    operationId: 'delete-owner',
  });
  assert.equal(finished.status, 'removed');
  assert.equal(await h.adapter.get('images', 'image'), null);
});
