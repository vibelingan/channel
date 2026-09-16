import assert from 'node:assert/strict';
import test from 'node:test';
import { AlibabaSyncApiError } from './alibaba-catalog-sync/alibaba-api.ts';
import { importAlibabaGallery } from './alibaba-gallery-import.ts';

test('description import retains 17 images, retries confirmed source mappings without duplicates', async () => {
  const urls = Array.from({ length: 17 }, (_, i) => `http://sc04.alicdn.com/detail-${i}.png`);
  const mapped = new Map<string, string>();
  const importer = async (url: string) => {
    assert.ok(url.startsWith('https:'));
    const existing = mapped.get(url);
    const imageId = existing ?? `description-${mapped.size}`;
    mapped.set(url, imageId);
    return { imageId, deduplicated: existing !== undefined };
  };
  const first = await importAlibabaGallery({
    sourceUrls: urls,
    imageIds: [],
    maxItems: 18,
    importImage: importer,
    onProgress: () => {},
  });
  assert.equal(first.imageIds.length, 17);
  const retry = await importAlibabaGallery({
    sourceUrls: urls,
    imageIds: [],
    maxItems: 18,
    importImage: importer,
    onProgress: () => {},
  });
  assert.deepEqual(retry.imageIds, first.imageIds);
  assert.equal(retry.createdIds.length, 0);
  assert.equal(mapped.size, 17);
});

test('gallery imports every unique allowed image in order, retaining successes on partial failure', async () => {
  const commits: string[][] = [];
  const requests: string[] = [];
  const result = await importAlibabaGallery({
    sourceUrls: [
      'https://sc04.alicdn.com/a.jpg',
      'https://sc04.alicdn.com/a.jpg',
      'https://sc04.alicdn.com/b.jpg',
      'https://sc04.alicdn.com/c.jpg',
      'http://127.0.0.1/a',
    ],
    imageIds: ['existing'],
    importImage: async (url) => {
      requests.push(url);
      if (url.endsWith('b.jpg'))
        throw new AlibabaSyncApiError('VALIDATION_ERROR', 'Image rejected');
      return { imageId: url.endsWith('a.jpg') ? 'a' : 'c', deduplicated: false };
    },
    onProgress: (ids) => commits.push(ids),
  });
  assert.equal(requests.length, 3);
  assert.deepEqual(result.imageIds, ['existing', 'a', 'c']);
  assert.deepEqual(result.createdIds, ['a', 'c']);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(commits, [
    ['existing', 'a'],
    ['existing', 'a', 'c'],
  ]);
});

test('gallery stops after a lost response or revoked session and retains earlier images', async () => {
  for (const error of [
    new TypeError('Network failed'),
    new AlibabaSyncApiError('UNAUTHORIZED', 'Sign in again'),
  ]) {
    let calls = 0;
    const result = await importAlibabaGallery({
      sourceUrls: ['a', 'b', 'c'].map((n) => `https://sc04.alicdn.com/${n}.jpg`),
      imageIds: [],
      importImage: async () => {
        if (++calls === 2) throw error;
        return { imageId: 'first', deduplicated: false };
      },
      onProgress: () => undefined,
    });
    assert.equal(calls, 2);
    assert.deepEqual(result.imageIds, ['first']);
    assert.equal(result.remaining, 1);
  }
});

test('gallery deduplicates existing imports and stops at the nine-image limit', async () => {
  let calls = 0;
  const result = await importAlibabaGallery({
    sourceUrls: ['a', 'b', 'c'].map((name) => `https://sc04.alicdn.com/${name}.jpg`),
    imageIds: Array.from({ length: 8 }, (_, i) => String(i)),
    importImage: async () => {
      calls += 1;
      return { imageId: calls === 1 ? '0' : 'new', deduplicated: true };
    },
    onProgress: () => undefined,
  });
  assert.equal(calls, 2);
  assert.equal(result.imageIds.length, 9);
  assert.deepEqual(result.createdIds, []);
  assert.equal(result.remaining, 1);
});

test('invalid source data makes no import calls', async () => {
  for (const sourceUrls of [null, '', undefined, { url: 'bad' }]) {
    const result = await importAlibabaGallery({
      sourceUrls,
      imageIds: [],
      importImage: async () => {
        throw new Error('must not call');
      },
      onProgress: () => undefined,
    });
    assert.deepEqual(result.imageIds, []);
    assert.deepEqual(result.failures, []);
  }
});
