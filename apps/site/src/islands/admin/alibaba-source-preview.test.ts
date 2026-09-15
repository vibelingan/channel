import assert from 'node:assert/strict';
import test from 'node:test';
import { alibabaSourcePreviewInfo, alibabaSourcePreviewUrls } from './alibaba-source-preview.ts';

test('source image count includes valid unique images beyond the import capacity', () => {
  const urls = Array.from({ length: 23 }, (_, i) => `https://sc04.alicdn.com/detail-${i}.jpg`);
  assert.deepEqual(alibabaSourcePreviewInfo([...urls, urls[0], 'javascript:alert(1)', null], 18), {
    urls: urls.slice(0, 18),
    total: 23,
  });
  assert.deepEqual(alibabaSourcePreviewInfo(undefined), { urls: [], total: 0 });
  assert.deepEqual(alibabaSourcePreviewInfo(urls, Number.NaN), { urls: [], total: 0 });
});

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
    ['https://sc04.alicdn.com/insecure.jpg'],
  );
});

test('description sources upgrade allowed HTTP hosts only, deduplicate and use their separate capacity', () => {
  const urls = Array.from({ length: 19 }, (_, i) => `http://sc04.alicdn.com/detail-${i}.jpg`);
  const first = 'https://sc04.alicdn.com/detail-0.jpg';
  assert.equal(alibabaSourcePreviewUrls(urls, 18).length, 18);
  assert.deepEqual(
    alibabaSourcePreviewUrls([
      'http://localhost/a',
      'http://alicdn.com.evil.example/a',
      'http://user:pass@sc04.alicdn.com/a',
      'http://sc04.alicdn.com:8080/a',
      urls[0],
      first,
    ]),
    [first],
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
