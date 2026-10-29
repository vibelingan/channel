import assert from 'node:assert/strict';
import test from 'node:test';
import { guardCatalogHostingAdapters } from './catalog-hosting-guard.mjs';
function fixture() {
  const calls = [];
  let fail = false;
  const delivery = {
    begin: async (ids, discovery) => {
      calls.push(['begin', ids, discovery]);
      return { owner: 'o', fence: 1, products: ids };
    },
    end: async (ticket, state) => calls.push(['end', state]),
    check: async () => calls.push(['check']),
  };
  const api = {
    uploadBatch: async () => {
      calls.push(['upload']);
      if (fail) throw Error('unknown transport');
    },
    verifyBatch: async () => calls.push(['readback']),
    removeBatch: async () => calls.push(['delete-and-readback']),
    accept: async () => calls.push(['accept']),
  };
  return {
    calls,
    api: guardCatalogHostingAdapters(api, delivery, new Map([['products/p-p/index.html', 'p']])),
    fail: () => {
      fail = true;
    },
  };
}
test('the actual adapter boundary holds a product from upload through readback, but never locks assets', async () => {
  const f = fixture();
  const entries = [{ path: 'products/p-p/index.html' }];
  await f.api.uploadBatch(entries);
  assert.deepEqual(f.calls, [['begin', ['p'], false], ['upload']]);
  await f.api.verifyBatch(entries);
  assert.deepEqual(f.calls.slice(-2), [['readback'], ['end', 'verified']]);
  const before = f.calls.length;
  await f.api.uploadBatch([{ path: '_astro/code.hash.js' }]);
  assert.deepEqual(f.calls.slice(before), [['upload']]);
});
test('sitemaps briefly coordinate all public changes; removals release only after built-in 404 readback', async () => {
  const f = fixture();
  await f.api.uploadBatch([{ path: 'sitemap-0.xml' }]);
  await f.api.verifyBatch([{ path: 'sitemap-0.xml' }]);
  assert.deepEqual(f.calls[0], ['begin', [], true]);
  await f.api.removeBatch(['products/p-p/index.html']);
  assert.deepEqual(f.calls.slice(-3), [
    ['begin', ['p'], false],
    ['delete-and-readback'],
    ['end', 'verified'],
  ]);
});
test('an unknown storage result keeps the durable guard blocked and prevents a silent release', async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(f.api.uploadBatch([{ path: 'products/p-p/index.html' }]), /unknown/);
  assert.deepEqual(f.calls.at(-1), ['end', 'unknown']);
});
