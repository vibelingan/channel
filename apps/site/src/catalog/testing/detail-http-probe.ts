/** Test-only consumer process; invoked by the local-server integration suite. */
import assert from 'node:assert/strict';
import { acceptDetailPage, startDetailPages } from '../application/catalog-detail-pages.ts';
import { fetchCatalogDetailPage } from '../infrastructure/catalog-detail-api.ts';

const [base, productId, expected] = process.argv.slice(2);
assert.ok(base && productId && expected);
const origin = new URL(base);
assert.equal(origin.protocol, 'http:');
assert.equal(origin.hostname, '127.0.0.1');
const transport = {
  fetch: ((url, init) => {
    const target = new URL(String(url), origin);
    assert.equal(target.origin, origin.origin);
    return fetch(target, init);
  }) satisfies typeof fetch,
};
const first = await fetchCatalogDetailPage({ productId }, transport);
if (expected === 'not-found') {
  assert.deepEqual(first, { status: 'not-found' });
} else {
  assert.equal(first.status, 'ready');
  assert.ok(first.status === 'ready');
  let pages = startDetailPages(first.detail, first.bytes);
  while (pages.status === 'ready' && pages.value.mode === 'collecting') {
    const next = await fetchCatalogDetailPage(
      {
        productId,
        page: pages.value.currentPage.variants.page + 1,
        revision: first.detail.revision,
      },
      transport,
    );
    assert.ok(next.status === 'ready');
    pages = acceptDetailPage(pages.value, next.detail, next.bytes);
  }
  assert.ok(pages.status === 'ready');
  assert.equal(pages.value.mode, 'complete');
  assert.equal(pages.value.items.length, Number(expected));
  assert.equal(new Set(pages.value.items.map((v) => v.id)).size, Number(expected));
  const publicPayload = JSON.stringify(pages.value);
  for (const secret of [
    'accountKey',
    'sourceVariantKey',
    'rawPayload',
    'evidenceId',
    'https://example.com',
  ]) {
    assert.equal(publicPayload.includes(secret), false);
  }
  assert.deepEqual(
    await fetchCatalogDetailPage({ productId, page: 2, revision: 'obsolete-revision' }, transport),
    { status: 'refresh-required' },
  );
}
