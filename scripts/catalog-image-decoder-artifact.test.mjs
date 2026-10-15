import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FUNCTION_NAMES } from './cloudbase-function-manifest.mjs';

const source = new URL('./catalog-image-decoder-artifact.mjs', import.meta.url);
const load = () => import(source.href);
const req = createRequire(new URL('../apps/functions/admin/package.json', import.meta.url));
const { require: tsxRequire } = req('tsx/cjs/api');
const { buildSync } = createRequire(realpathSync(req.resolve('tsup')))('esbuild');
const host = `${process.platform}-${process.arch}`;
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-decoder-artifact-test-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test('the decoder package work preserves the three application function identities', () => {
  assert.deepEqual(FUNCTION_NAMES, ['admin', 'public-api', 'alibaba-catalog-sync']);
});
for (const name of FUNCTION_NAMES)
  test(`${name} preserves the private runtime import in its bundle`, () => {
    const config = tsxRequire(`../apps/functions/${name}/tsup.config.ts`, import.meta.url).default;
    assert.ok(config.external?.includes('#catalog-image-decoder'));
  });
test('only bundles using the private decoder import require the native package', async () => {
  const { usesCatalogImageDecoder } = await load();
  for (const code of [
    'await import("#catalog-image-decoder")',
    "require('#catalog-image-decoder')",
  ])
    assert.equal(usesCatalogImageDecoder(code), true);
  assert.equal(usesCatalogImageDecoder('exports.main = () => ({ok:true})'), false);
});
test('the package is self-contained after root node_modules removal and relocation', async () => {
  const {
    packageCatalogImageDecoder,
    verifyCatalogImageDecoderArtifact,
    smokeCatalogImageDecoder,
  } = await load();
  fixture((dir) => {
    const original = join(dir, 'original');
    const manifest = packageCatalogImageDecoder(original, { target: host });
    assert.equal(manifest.target, host);
    assert.equal(manifest.sharpVersion, '0.35.5');
    assert.ok(manifest.packages.some((p) => p.name === '@img/colour'));
    const relocated = join(dir, 'relocated');
    cpSync(original, relocated, { recursive: true });
    rmSync(join(relocated, 'node_modules'), { recursive: true, force: true });
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false);
        if (entry.isDirectory()) walk(join(path, entry.name));
      }
    };
    walk(relocated);
    verifyCatalogImageDecoderArtifact(relocated);
    const result = smokeCatalogImageDecoder(relocated);
    assert.equal(result.sharpVersion, '0.35.5');
    assert.deepEqual(result.formats, ['jpeg', 'png', 'gif', 'webp']);
  });
});
test('the deploy artifact always carries fixed Linux x64 binaries without Mac binaries', async () => {
  const { packageCatalogImageDecoder, verifyCatalogImageDecoderArtifact } = await load();
  fixture((dir) => {
    const result = packageCatalogImageDecoder(dir);
    assert.equal(result.target, 'linux-x64');
    assert.ok(
      result.packages.some((p) => p.name === '@img/sharp-linux-x64' && p.version === '0.35.5'),
    );
    assert.ok(
      result.packages.some(
        (p) => p.name === '@img/sharp-libvips-linux-x64' && p.version === '1.3.4',
      ),
    );
    assert.equal(
      result.packages.some((p) => p.name.includes('darwin')),
      false,
    );
    assert.ok(result.files.some((p) => p.path.endsWith('.node')));
    assert.ok(result.files.some((p) => p.path.includes('.so.')));
    verifyCatalogImageDecoderArtifact(dir);
  });
});
for (const damage of [
  'missing-wrapper',
  'missing-native',
  'modified-native',
  'missing-js-dependency',
  'version-drift',
])
  test(`artifact validation rejects ${damage}`, async () => {
    const { packageCatalogImageDecoder, verifyCatalogImageDecoderArtifact } = await load();
    fixture((dir) => {
      const result = packageCatalogImageDecoder(dir, { target: host });
      if (damage === 'version-drift') {
        const file = join(dir, 'vendor/node_modules/sharp/package.json');
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        pkg.version = '0.34.5';
        writeFileSync(file, JSON.stringify(pkg));
      } else {
        const target =
          damage === 'missing-wrapper'
            ? 'vendor/image-decoder.mjs'
            : damage === 'missing-js-dependency'
              ? 'vendor/node_modules/detect-libc/package.json'
              : result.files.find((p) => p.path.endsWith('.node')).path;
        if (damage === 'modified-native') writeFileSync(join(dir, target), 'corrupt');
        else rmSync(join(dir, target));
      }
      assert.throws(() => verifyCatalogImageDecoderArtifact(dir));
    });
  });
test('a missing native package fails packaging instead of relying on online installation', async () => {
  const { packageCatalogImageDecoder } = await load();
  fixture((dir) => {
    const fake = join(dir, 'fake');
    mkdirSync(join(fake, 'node_modules/sharp/dist'), { recursive: true });
    writeFileSync(
      join(fake, 'package.json'),
      JSON.stringify({ dependencies: { sharp: '0.35.5' } }),
    );
    writeFileSync(
      join(fake, 'node_modules/sharp/package.json'),
      JSON.stringify({
        name: 'sharp',
        version: '0.35.5',
        main: './dist/index.cjs',
        optionalDependencies: {
          '@img/sharp-linux-x64': '0.35.5',
          '@img/sharp-libvips-linux-x64': '1.3.4',
        },
      }),
    );
    writeFileSync(join(fake, 'node_modules/sharp/dist/index.cjs'), '');
    assert.throws(() =>
      packageCatalogImageDecoder(join(dir, 'out'), {
        consumerManifest: join(fake, 'package.json'),
      }),
    );
  });
});
test('the executable smoke detects a broken loader even when its file hash is updated', async () => {
  const { packageCatalogImageDecoder, smokeCatalogImageDecoder } = await load();
  fixture((dir) => {
    packageCatalogImageDecoder(dir, { target: host });
    const broken = 'export default function(){throw new Error("broken native loader")}';
    writeFileSync(join(dir, 'vendor/image-decoder.mjs'), broken);
    const file = join(dir, 'image-decoder-manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const row = manifest.files.find((x) => x.path === 'vendor/image-decoder.mjs');
    row.bytes = Buffer.byteLength(broken);
    row.sha256 = createHash('sha256').update(broken).digest('hex');
    writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => smokeCatalogImageDecoder(dir));
  });
});
test('Linux decoder execution cannot be reported as successful on an incompatible host', async () => {
  const { packageCatalogImageDecoder, smokeCatalogImageDecoder } = await load();
  fixture((dir) => {
    packageCatalogImageDecoder(dir);
    if (host !== 'linux-x64')
      assert.throws(() => smokeCatalogImageDecoder(dir), /Linux|runtime|target/i);
    else assert.equal(smokeCatalogImageDecoder(dir).sharpVersion, '0.35.5');
  });
});
test('every artifact smoke checks a decoder used by the built entry', () => {
  const source = readFileSync(new URL('./smoke-function-artifacts.mjs', import.meta.url), 'utf8');
  assert.match(source, /usesCatalogImageDecoder/);
  assert.match(source, /smokeCatalogImageDecoder/);
});

for (const damage of ['none', 'missing-manifest', 'broken-loader', 'wrong-import-map'])
  test(`the actual function-artifact command enforces decoder smoke: ${damage}`, async () => {
    const { packageCatalogImageDecoder } = await load();
    fixture((dir) => {
      for (const name of FUNCTION_NAMES) {
        const target = join(dir, name);
        mkdirSync(target, { recursive: true });
        writeFileSync(
          join(target, 'package.json'),
          JSON.stringify({ private: true, dependencies: {} }),
        );
        writeFileSync(join(target, 'index.js'), 'exports.main = () => ({ok:true});');
      }
      const config = tsxRequire(
        '../apps/functions/public-api/tsup.config.ts',
        import.meta.url,
      ).default;
      buildSync({
        entryPoints: [
          fileURLToPath(new URL('../apps/functions/public-api/src/index.ts', import.meta.url)),
        ],
        outfile: join(dir, 'public-api/index.js'),
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        minify: true,
        define: config.define,
        external: config.external,
      });
      const admin = join(dir, 'admin');
      writeFileSync(
        join(admin, 'index.js'),
        'exports.main = () => import("#catalog-image-decoder");',
      );
      packageCatalogImageDecoder(admin, { target: host });
      if (damage === 'missing-manifest') rmSync(join(admin, 'image-decoder-manifest.json'));
      if (damage === 'wrong-import-map') {
        const file = join(admin, 'package.json');
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        pkg.imports['#catalog-image-decoder'] = './missing.mjs';
        writeFileSync(file, JSON.stringify(pkg));
      }
      if (damage === 'broken-loader') {
        const bytes = 'export default function(){throw new Error("broken native loader")}';
        writeFileSync(join(admin, 'vendor/image-decoder.mjs'), bytes);
        const file = join(admin, 'image-decoder-manifest.json');
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        const row = manifest.files.find((x) => x.path === 'vendor/image-decoder.mjs');
        row.bytes = Buffer.byteLength(bytes);
        row.sha256 = createHash('sha256').update(bytes).digest('hex');
        writeFileSync(file, JSON.stringify(manifest));
      }
      const result = spawnSync(
        process.execPath,
        [new URL('./smoke-function-artifacts.mjs', import.meta.url).pathname],
        {
          env: { ...process.env, CHANNEL_FUNCTION_ARTIFACT_ROOT: dir },
          encoding: 'utf8',
          timeout: 15000,
        },
      );
      if (damage === 'none') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /alibaba-catalog-sync: artifact smoke passed/);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /decoder|Decoder|ENOENT/);
        assert.doesNotMatch(result.stdout, /admin: artifact smoke passed/);
      }
    });
  });

for (const name of FUNCTION_NAMES)
  test(`${name} build configuration keeps the pixel module usable after relocation`, async () => {
    const { packageCatalogImageDecoder } = await load();
    const sharp = createRequire(new URL('../packages/media-storage/package.json', import.meta.url))(
      'sharp',
    );
    const bytes = await sharp({
      create: { width: 24, height: 16, channels: 4, background: '#12345680' },
    })
      .png()
      .toBuffer();
    const checksum = createHash('sha256').update(bytes).digest('hex');
    fixture((dir) => {
      const config = tsxRequire(
        `../apps/functions/${name}/tsup.config.ts`,
        import.meta.url,
      ).default;
      const entry = `import {decodeCatalogImagePixels} from ${JSON.stringify(fileURLToPath(new URL('../packages/media-storage/src/pixels.ts', import.meta.url)))}; export const main = () => decodeCatalogImagePixels(Buffer.from(${JSON.stringify(bytes.toString('base64'))},"base64"),"image/png");`;
      buildSync({
        stdin: { contents: entry, loader: 'ts', resolveDir: dir },
        outfile: join(dir, 'index.js'),
        bundle: true,
        platform: 'node',
        target: config.target,
        format: 'cjs',
        minify: true,
        external: config.external,
      });
      packageCatalogImageDecoder(dir, { target: host });
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `const assert=require("node:assert/strict");require("./index.js").main().then(r=>assert.deepEqual(r,${JSON.stringify({ status: 'decoded', kind: 'catalog-image-pixels-v1', checksumSha256: checksum, width: 24, height: 16, pages: 1 })})).catch(e=>{console.error(e);process.exitCode=1;});`,
        ],
        {
          cwd: dir,
          env: { PATH: process.env.PATH, SHARP_IGNORE_GLOBAL_LIBVIPS: '1' },
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
    });
  });
