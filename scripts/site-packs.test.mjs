import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from './release/input.mjs';
import { SITE_PACK_LAYOUT, checkSitePackLayout, planSitePacks } from './release/site-packs.mjs';

const entry = (path, body) => ({
  path,
  bytes: Buffer.byteLength(body),
  sha256: sha256(Buffer.from(body)),
});
const manifest = { bytes: 10, sha256: 'f'.repeat(64) };
const entries = [
  entry('index.html', '<main>home</main>'),
  entry('compatibility.json', '{}'),
  entry('product-snapshot.json', 'x'.repeat(2048)),
  ...Array.from({ length: 40 }, (_, n) => entry(`p/${n}/index.html`, `<p>${n}</p>`)),
];
const layout = { ...SITE_PACK_LAYOUT, packs: 4, soloBytes: 1024 };

test('the plan is a pure function of the manifest and layout', () => {
  const plan = planSitePacks({ entries, manifest, layout });
  assert.deepEqual(planSitePacks({ entries: [...entries].reverse(), manifest, layout }), plan);
  const head = plan.find((item) => item.key === 'head');
  assert.deepEqual(
    head.members.map((m) => m[0]),
    ['compatibility.json', 'payload-manifest.json'],
  );
  assert.deepEqual(
    plan.find((item) => item.key === 'solo:product-snapshot.json').members.length,
    1,
  );
  assert.equal(plan.filter((item) => item.key.startsWith('pack:')).length, 4);
  const members = plan.flatMap((item) => item.members.map((m) => m[0])).sort();
  assert.deepEqual(members, [...entries.map((e) => e.path), 'payload-manifest.json'].sort());
});

test('a changed file changes only its own object; a new run changes only the head', () => {
  const plan = planSitePacks({ entries, manifest, layout });
  const changed = entries.map((e) =>
    e.path === 'p/7/index.html' ? entry(e.path, '<p>new</p>') : e,
  );
  const next = planSitePacks({ entries: changed, manifest, layout });
  const differs = next.filter((item, n) => item.contentSha256 !== plan[n].contentSha256);
  assert.equal(differs.length, 1);
  assert.ok(differs[0].members.some((m) => m[0] === 'p/7/index.html'));
  const rerun = planSitePacks({ entries, manifest: { bytes: 11, sha256: 'e'.repeat(64) }, layout });
  assert.deepEqual(
    rerun.filter((item, n) => item.contentSha256 !== plan[n].contentSha256).map((item) => item.key),
    ['head'],
  );
});

test('duplicate members, malformed members and unknown layouts are refused', () => {
  assert.throws(
    () => planSitePacks({ entries: [...entries, entries[0]], manifest, layout }),
    /Duplicate/,
  );
  assert.throws(
    () => planSitePacks({ entries: [entry('payload-manifest.json', 'x')], manifest, layout }),
    /Duplicate/,
  );
  assert.throws(
    () => planSitePacks({ entries: [{ path: 'a', bytes: -1 }], manifest, layout }),
    /Invalid/,
  );
  assert.throws(() => planSitePacks({ entries: [], manifest, layout }), /needs members/);
  assert.throws(() => checkSitePackLayout({ ...layout, version: 2 }), /Unsupported/);
  assert.throws(() => checkSitePackLayout({ ...layout, packs: 0 }), /Unsupported/);
});

const python = (...args) =>
  execFileSync(
    'python3',
    [new URL(`./release/${args[0]}`, import.meta.url).pathname, ...args.slice(1)],
    {
      stdio: 'pipe',
    },
  );

function packed(t) {
  const root = mkdtempSync(join(tmpdir(), 'site-objects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = join(root, 'payload');
  const files = {
    'payload-manifest.json': '{"m":1}',
    'static-manifest.json': '{}',
    'compatibility.json': '{}',
    'product-snapshot.json': '{"p":[]}',
    'index.html': '<main>home</main>',
    'a/index.html': '<p>a</p>',
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(payload, path, '..'), { recursive: true });
    writeFileSync(join(payload, path), body);
  }
  const member = (path) => [path, Buffer.byteLength(files[path]), sha256(Buffer.from(files[path]))];
  const groups = [
    ['payload-manifest.json', 'compatibility.json'],
    ['static-manifest.json', 'product-snapshot.json'],
    ['index.html', 'a/index.html'],
  ];
  const zips = groups.map((_, n) => join(root, `${n}.zip`));
  writeFileSync(
    join(root, 'pack.json'),
    JSON.stringify(groups.map((g, n) => ({ output: zips[n], members: g }))),
  );
  python('pack-site-objects.py', payload, join(root, 'pack.json'));
  const plan = groups.map((g, n) => ({ zip: zips[n], members: g.map(member) }));
  const write = (name, value) => {
    writeFileSync(join(root, name), JSON.stringify(value));
    return join(root, name);
  };
  return { root, payload, zips, plan, write, member, files };
}

test('packed objects are byte-stable and extract to exactly the planned files', (t) => {
  const x = packed(t);
  const first = x.zips.map((zip) => sha256(readFileSync(zip)));
  rmSync(x.zips[2]);
  writeFileSync(
    join(x.root, 'again.json'),
    JSON.stringify([{ output: x.zips[2], members: ['index.html', 'a/index.html'] }]),
  );
  python('pack-site-objects.py', x.payload, join(x.root, 'again.json'));
  assert.equal(sha256(readFileSync(x.zips[2])), first[2]);
  python('extract-site-objects.py', 'check', x.write('plan.json', x.plan));
  assert.equal(
    python('extract-site-objects.py', 'read', x.zips[0], 'payload-manifest.json').toString(),
    '{"m":1}',
  );
  const out = join(x.root, 'out');
  python('extract-site-objects.py', 'extract', x.write('extract.json', x.plan), out);
  assert.equal(readFileSync(join(out, 'a/index.html'), 'utf8'), '<p>a</p>');
});

test('the extractor refuses missing, extra, resized, altered and duplicated members, leaving no output', (t) => {
  const x = packed(t);
  const out = join(x.root, 'out');
  const refuse = (plan, pattern) => {
    assert.throws(
      () =>
        python('extract-site-objects.py', 'extract', x.write(`p-${Math.random()}.json`, plan), out),
      (error) => pattern.test(error.stderr.toString()),
    );
    assert.throws(() => readFileSync(join(out, 'index.html')));
  };
  const withMembers = (index, members) =>
    x.plan.map((item, n) => (n === index ? { ...item, members } : item));
  refuse(withMembers(2, [x.member('index.html')]), /differ from its plan/);
  refuse(
    withMembers(2, [...x.plan[2].members, ['b.html', 1, 'a'.repeat(64)]]),
    /differ from its plan/,
  );
  refuse(
    withMembers(2, [['index.html', 3, x.plan[2].members[0][2]], x.plan[2].members[1]]),
    /Unsupported/,
  );
  refuse(
    withMembers(2, [['index.html', x.plan[2].members[0][1], '0'.repeat(64)], x.plan[2].members[1]]),
    /member differs/,
  );
  refuse([...x.plan, x.plan[2]], /Unsafe/);
  refuse(x.plan.slice(1), /Incomplete/);
});
