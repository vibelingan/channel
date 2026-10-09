import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alibabaPhotoSources, alibabaPhotoSourcesInfo } from './alibaba-photo-sources.ts';

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
