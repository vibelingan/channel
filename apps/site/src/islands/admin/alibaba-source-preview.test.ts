import assert from 'node:assert/strict';
import test from 'node:test';
import { alibabaSourcePreviewUrls } from './alibaba-source-preview.ts';

test('full source preview keeps images six through nine and caps at catalog capacity', () => {
  const urls = Array.from({ length: 10 }, (_, i) => `https://sc04.alicdn.com/image-${i}.jpg`);
  assert.deepEqual(alibabaSourcePreviewUrls(urls.slice(0, 6)), urls.slice(0, 6));
  assert.deepEqual(alibabaSourcePreviewUrls([urls[0], ...urls]), urls.slice(0, 9));
});

test('admin source previews allow only bounded HTTPS Alibaba CDN URLs', () => {
  assert.deepEqual(
    alibabaSourcePreviewUrls(
      [
        '',
        null,
        'javascript:alert(1)',
        'http://sc04.alicdn.com/insecure.jpg',
        'https://alicdn.com.evil.example/fake.jpg',
        'https://sc04.alicdn.com/one.jpg',
        'https://img.alibaba.com/two.jpg',
      ],
      1,
    ),
    ['https://sc04.alicdn.com/one.jpg'],
  );
});

test('admin source previews reject unbounded URLs and non-positive limits', () => {
  const long = `https://sc04.alicdn.com/${'a'.repeat(2_048)}`;
  assert.deepEqual(alibabaSourcePreviewUrls([long]), []);
  assert.deepEqual(alibabaSourcePreviewUrls(['https://sc04.alicdn.com/product.jpg'], 0), []);
  assert.deepEqual(alibabaSourcePreviewUrls(['https://sc04.alicdn.com/product.jpg'], -1), []);
  assert.deepEqual(
    alibabaSourcePreviewUrls(['https://sc04.alicdn.com/product.jpg'], Number.NaN),
    [],
  );
  assert.deepEqual(
    alibabaSourcePreviewUrls(['https://sc04.alicdn.com/product.jpg'], Number.POSITIVE_INFINITY),
    [],
  );
});
