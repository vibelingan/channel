import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBuiltSite, sealBuiltSite } from './release/site-build-record.mjs';
test('normal delivery consumes exact built bytes and both frozen inputs, refusing stale or changed output', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'site-build-record-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'site');
  mkdirSync(join(dist, 'errors'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<main>verified build</main>');
  writeFileSync(join(dist, 'errors/not-found.html'), '404');
  const productFile = join(root, 'products.json');
  const blogFile = join(root, 'blog.json');
  const recordFile = join(root, 'build.json');
  writeFileSync(productFile, 'public product snapshot');
  writeFileSync(blogFile, 'accepted public articles');
  const input = { codeSha: 'a'.repeat(40), dist, productFile, blogFile, recordFile };
  sealBuiltSite(input);
  assert.equal(readBuiltSite(input).get('index.html').toString(), '<main>verified build</main>');
  assert.throws(() => sealBuiltSite(input), /EEXIST/);
  assert.throws(() => readBuiltSite({ ...input, codeSha: 'b'.repeat(40) }));
  for (const file of [join(dist, 'index.html'), productFile, blogFile]) {
    const original = readFileSync(file);
    writeFileSync(file, 'changed');
    assert.throws(() => readBuiltSite(input));
    writeFileSync(file, original);
  }
  assert.equal(readBuiltSite(input).size, 2);
});

test('server Blog records its separate ownership and never requires or freezes a fake article snapshot', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'server-blog-record-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'site');
  mkdirSync(join(dist, 'errors'), { recursive: true });
  writeFileSync(join(dist, 'errors/not-found.html'), '404');
  writeFileSync(join(dist, 'index.html'), '<main>SSG products and marketing</main>');
  const productFile = join(root, 'products.json');
  writeFileSync(productFile, 'public products');
  const input = {
    codeSha: 'a'.repeat(40),
    dist,
    productFile,
    recordFile: join(root, 'record.json'),
    blogDelivery: 'server',
  };
  const record = sealBuiltSite(input);
  assert.equal(record.schemaVersion, 2);
  assert.deepEqual(record.blog, { delivery: 'server', apiContract: 'articles-v1' });
  assert.equal(record.blogSha256, undefined);
  assert.equal(readBuiltSite(input).size, 2);
  // Public article changes are owned by the page service, not this static package.
  writeFileSync(join(root, 'article.json'), 'a new live article');
  assert.equal(readBuiltSite(input).size, 2);
  assert.throws(() =>
    readBuiltSite({ ...input, blogDelivery: 'static', blogFile: join(root, 'absent.json') }),
  );
  assert.throws(() => readBuiltSite({ ...input, blogDelivery: 'unknown' }), /ownership/);
  writeFileSync(productFile, 'changed products');
  assert.throws(() => readBuiltSite(input));
});
