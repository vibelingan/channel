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
