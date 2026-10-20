import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const extractor = fileURLToPath(new URL('./release/extract-canary.py', import.meta.url));
function archive(t, extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'canary-zip-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const zip = join(dir, 'payload.zip');
  execFileSync('python3', [
    '-c',
    `import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for name in ['payload-manifest.json','static-manifest.json','compatibility.json','__release-canary/index.html']: z.writestr(name,'fixture')\n ${extra}`,
    zip,
  ]);
  return { dir, zip, out: join(dir, 'out') };
}
test('archive extraction accepts exactly four data files and refuses existing output', (t) => {
  const { zip, out } = archive(t);
  execFileSync('python3', [extractor, zip, out, '__release-canary/']);
  assert.equal(readFileSync(join(out, '__release-canary/index.html'), 'utf8'), 'fixture');
  assert.throws(() =>
    execFileSync('python3', [extractor, zip, out, '__release-canary/'], { stdio: 'pipe' }),
  );
});
for (const [label, extra] of [
  ['traversal', "z.writestr('../escaped','bad')"],
  ['duplicate', "z.writestr('compatibility.json','bad')"],
  ['oversize', "z.writestr('extra','x'*131073)"],
  ['script', "z.writestr('__release-canary/run.js','bad')"],
])
  test(`archive rejects ${label} before creating output`, (t) => {
    const { zip, out } = archive(t, extra);
    assert.throws(() =>
      execFileSync('python3', [extractor, zip, out, '__release-canary/'], { stdio: 'pipe' }),
    );
  });

test('archive refuses a symlink even when all four member names are allowed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const zip = join(dir, 'link.zip');
  const out = join(dir, 'out');
  execFileSync('python3', [
    '-c',
    `import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for name in ['payload-manifest.json','static-manifest.json','compatibility.json']: z.writestr(name,'fixture')\n item=zipfile.ZipInfo('__release-canary/index.html'); item.create_system=3; item.external_attr=0o120777<<16; z.writestr(item,'/outside')`,
    zip,
  ]);
  assert.throws(() =>
    execFileSync('python3', [extractor, zip, out, '__release-canary/'], { stdio: 'pipe' }),
  );
});
