import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alibabaPhotoSource,
  alibabaPhotoSources,
  alibabaPhotoSourcesInfo,
  allAlibabaPhotoSources,
} from './alibaba-photo-sources.ts';

test('Alibaba photo sources: HTTPS on Alibaba hosts only, de-duplicated, in order, bounded', () => {
  const sources = [
    'http://sc04.alicdn.com/a.jpg',
    'https://sc04.alicdn.com/a.jpg',
    'https://evil.example.com/x.jpg',
    'https://s.alibaba.com/b.png',
    'https://user:pw@sc04.alicdn.com/c.jpg',
    'ftp://sc04.alicdn.com/d.jpg',
    42,
    'https://sc04.alicdn.com/e.jpg',
  ];
  assert.deepEqual(alibabaPhotoSources(sources, 9), [
    'https://sc04.alicdn.com/a.jpg',
    'https://s.alibaba.com/b.png',
    'https://sc04.alicdn.com/e.jpg',
  ]);
  assert.deepEqual(alibabaPhotoSources(sources, 2), [
    'https://sc04.alicdn.com/a.jpg',
    'https://s.alibaba.com/b.png',
  ]);
  assert.deepEqual(alibabaPhotoSourcesInfo(sources, 2), {
    urls: ['https://sc04.alicdn.com/a.jpg', 'https://s.alibaba.com/b.png'],
    total: 3,
  });
  assert.deepEqual(alibabaPhotoSources('nope', 9), []);
  // The description limit is the largest bound.
  const many = Array.from({ length: 30 }, (_, i) => `https://sc04.alicdn.com/${i}.jpg`);
  assert.equal(alibabaPhotoSources(many, 99).length, 18);
});

test('every Alibaba photo source can be listed for choosing beyond the limit', () => {
  const many = Array.from({ length: 23 }, (_, i) => `https://sc04.alicdn.com/${i}.jpg`);
  assert.equal(allAlibabaPhotoSources(many).length, 23);
  assert.equal(alibabaPhotoSourcesInfo(many, 18).total, 23);
  assert.deepEqual(allAlibabaPhotoSources([...many, many[0], 'http://evil.com/x.jpg']), many);
});

test('source choices retain their 200-item cap and their existing transport policy', () => {
  const many = Array.from({ length: 205 }, (_, i) => `https://s.alibaba.com/${i}.jpg`);
  assert.deepEqual(allAlibabaPhotoSources(many), many.slice(0, 200));
  assert.deepEqual(
    allAlibabaPhotoSources([
      'http://s.alibaba.com/photo.jpg',
      'HTTP://S.ALIBABA.COM/photo.jpg',
      'http://s.alibaba.com:81/photo.jpg',
      'https://alibaba.com.evil.test/photo.jpg',
      'https://evil-alibaba.com/photo.jpg',
      'https://name:secret@s.alibaba.com/photo.jpg',
      `https://s.alibaba.com/${'x'.repeat(2048)}`,
    ]),
    ['https://s.alibaba.com/photo.jpg'],
  );
});

test('one supplier URL uses the same copy policy without a collection cap', async (t) => {
  const cases: [unknown, string | undefined][] = [
    ['http://s.alibaba.com/photo.jpg?size=large', 'https://s.alibaba.com/photo.jpg?size=large'],
    ['HTTP://SC04.ALICDN.COM/photo.jpg', 'https://sc04.alicdn.com/photo.jpg'],
    ['https://s.alibaba.com:443/photo.jpg', 'https://s.alibaba.com/photo.jpg'],
    ['https://s.alibaba.com:81/photo.jpg', undefined],
    ['http://s.alibaba.com:443/photo.jpg', undefined],
    ['https://name:secret@s.alibaba.com/photo.jpg', undefined],
    ['https://name@s.alibaba.com/photo.jpg', undefined],
    ['https://:secret@s.alibaba.com/photo.jpg', undefined],
    ['https://alibaba.com.evil.test/photo.jpg', undefined],
    ['https://example.com/photo.jpg', undefined],
    ['ftp://s.alibaba.com/photo.jpg', undefined],
    [`https://s.alibaba.com/${'x'.repeat(2048)}`, undefined],
    [null, undefined],
    [42, undefined],
    ['not-a-url', undefined],
    ['', undefined],
  ];
  for (const [input, expected] of cases)
    await t.test(JSON.stringify(input), () => assert.equal(alibabaPhotoSource(input), expected));
  const all = Array.from({ length: 205 }, (_, i) => `http://s.alibaba.com/${i}.jpg`);
  assert.deepEqual(
    all.map(alibabaPhotoSource),
    all.map((url) => url.replace('http:', 'https:')),
  );
});
