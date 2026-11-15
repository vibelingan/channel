import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const canonical = fileURLToPath(
  new URL('../../../../packages/sales-contracts/src/canonical.ts', import.meta.url),
);

// Source runs (tsx, Node 22) need the CommonJS `main`; bundles need the ESM
// build, because the UMD `main` requires ./impl/format at runtime. esbuild's
// own Node default reads `main` first, so this bundles that way on purpose.
test('the strict JSON parser loads from a bundle built main-first, with no node_modules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jsonc-bundle-'));
  try {
    const entry = join(directory, 'entry.ts');
    await writeFile(
      entry,
      `import { parseStrictJson } from ${JSON.stringify(canonical)};\nconsole.log(JSON.stringify(parseStrictJson('{"b":1,"a":[true]}')));\n`,
    );
    await build({
      config: false,
      silent: true,
      entry: { bundle: entry },
      outDir: join(directory, 'out'),
      format: ['cjs'],
      platform: 'node',
      target: 'node20',
      noExternal: [/.*/],
      esbuildOptions(options) {
        options.mainFields = ['main', 'module'];
      },
    });
    const [file] = await readdir(join(directory, 'out'));
    assert.ok(file);
    const bundle = join(directory, 'out', file);
    assert.doesNotMatch(await readFile(bundle, 'utf8'), /["']\.\/impl\//);
    const run = spawnSync(process.execPath, [bundle], {
      cwd: join(directory, 'out'),
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { b: 1, a: [true] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
