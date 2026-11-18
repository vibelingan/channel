import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../apps/site/', import.meta.url));
const require = createRequire(new URL('../apps/site/package.json', import.meta.url));
const tailwind = createRequire(require.resolve('@tailwindcss/vite'));
const { compile, optimize } = tailwind('@tailwindcss/node');
const { Scanner } = tailwind('@tailwindcss/oxide');

async function buildCss(app) {
  const file = join(app, 'src/styles/global.css');
  const compiler = await compile(readFileSync(file, 'utf8'), {
    base: dirname(file),
    onDependency() {},
  });
  // Use the installed Vite plugin's compiler root and source inputs.
  const sources = (
    compiler.root === 'none' ? [] : [compiler.root ?? { base: app, pattern: '**/*' }]
  ).map((source) => ({ ...source, negated: false }));
  const scanner = new Scanner({ sources: [...sources, ...compiler.sources] });
  return optimize(compiler.build(scanner.scan()), { minify: true }).code;
}

test('real site CSS excludes build files and dependency examples without Git metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'site-css-source-'));
  try {
    cpSync(join(site, 'src'), join(directory, 'src'), { recursive: true });
    symlinkSync(join(site, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const clean = await buildCss(directory);
    mkdirSync(join(directory, '.astro'));
    writeFileSync(join(directory, '.astro/previous-build.html'), '<div class="z-[87654321]">');
    const withBuildOutput = await buildCss(directory);
    assert.ok(!withBuildOutput.includes('z-index:87654321'), 'previous output entered site CSS');
    assert.equal(withBuildOutput, clean, 'generated files changed the stylesheet');
    assert.ok(!clean.includes('--my_variable'), 'Tailwind dependency examples entered site CSS');
    assert.ok(clean.includes('.rounded-2xl'), 'real website utility styles were lost');
    assert.ok(clean.includes('.assistant-activity-dots'), 'shared assistant styles were lost');
    assert.ok(clean.includes('prefers-reduced-motion'), 'accessibility styles were lost');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
