import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const consumerManifest = fileURLToPath(
  new URL('../packages/media-storage/package.json', import.meta.url),
);
const alias = '#catalog-image-decoder';
const wrapper = 'vendor/image-decoder.mjs';
const manifestName = 'image-decoder-manifest.json';
const targets = ['linux-x64', 'darwin-arm64', 'darwin-x64'];

export function usesCatalogImageDecoder(code) {
  return /\b(?:import|require)\s*\(\s*['"]#catalog-image-decoder['"]\s*\)/.test(code);
}

/** Materialize the installed dependency closure; never install or fetch during packaging. */
export function packageCatalogImageDecoder(artifactDir, options = {}) {
  const target = options.target ?? 'linux-x64';
  if (!targets.includes(target)) throw new Error(`Unsupported decoder target: ${target}`);
  const consumer = options.consumerManifest ?? consumerManifest;
  const pinned = JSON.parse(readFileSync(consumer, 'utf8')).dependencies?.sharp;
  if (!/^\d+\.\d+\.\d+$/.test(pinned ?? ''))
    throw new Error('Decoder must have an exact sharp version');
  const modules = join(artifactDir, 'vendor/node_modules');
  const packages = new Map();
  const copy = (name, from) => {
    const source = packageDirectory(name, from);
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    if (packages.has(name)) {
      if (packages.get(name).version !== pkg.version)
        throw new Error(`Conflicting decoder dependency: ${name}`);
      return pkg;
    }
    if (pkg.name !== name) throw new Error(`Unexpected decoder dependency: ${name}`);
    packages.set(name, { name, version: pkg.version });
    cpSync(source, join(modules, name), {
      recursive: true,
      dereference: true,
      filter: (file) => !relative(source, file).split(sep).includes('node_modules'),
    });
    for (const dependency of Object.keys(pkg.dependencies ?? {}))
      copy(dependency, join(source, 'package.json'));
    return pkg;
  };
  mkdirSync(modules, { recursive: true });
  const sharp = copy('sharp', consumer);
  if (sharp.version !== pinned)
    throw new Error('Installed sharp differs from its exact consumer pin');
  const sharpManifest = join(packageDirectory('sharp', consumer), 'package.json');
  for (const name of [`@img/sharp-${target}`, `@img/sharp-libvips-${target}`]) {
    const pkg = copy(name, sharpManifest);
    if (!sharp.optionalDependencies?.[name] || pkg.version !== sharp.optionalDependencies[name])
      throw new Error(`Native decoder version drift: ${name}`);
  }
  writeFileSync(
    join(artifactDir, wrapper),
    'export { default } from "./node_modules/sharp/dist/index.mjs";\n',
  );
  const packageFile = join(artifactDir, 'package.json');
  const pkg = existsSync(packageFile)
    ? JSON.parse(readFileSync(packageFile, 'utf8'))
    : { private: true, dependencies: {} };
  pkg.imports = { ...pkg.imports, [alias]: `./${wrapper}` };
  writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  const manifest = {
    target,
    sharpVersion: sharp.version,
    packages: [...packages.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    files: fileRecords(join(artifactDir, 'vendor'), artifactDir),
  };
  writeFileSync(join(artifactDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function verifyCatalogImageDecoderArtifact(artifactDir) {
  const manifest = JSON.parse(readFileSync(join(artifactDir, manifestName), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(artifactDir, 'package.json'), 'utf8'));
  const pinned = JSON.parse(readFileSync(consumerManifest, 'utf8')).dependencies.sharp;
  if (
    !targets.includes(manifest.target) ||
    manifest.sharpVersion !== pinned ||
    pkg.imports?.[alias] !== `./${wrapper}`
  )
    throw new Error('Decoder artifact runtime contract mismatch');
  if (
    JSON.stringify(manifest.files) !==
    JSON.stringify(fileRecords(join(artifactDir, 'vendor'), artifactDir))
  )
    throw new Error('Decoder artifact file integrity mismatch');
  for (const item of manifest.packages) {
    const actual = JSON.parse(
      readFileSync(join(artifactDir, 'vendor/node_modules', item.name, 'package.json'), 'utf8'),
    );
    if (actual.name !== item.name || actual.version !== item.version)
      throw new Error(`Decoder artifact package mismatch: ${item.name}`);
  }
  for (const name of [
    'sharp',
    `@img/sharp-${manifest.target}`,
    `@img/sharp-libvips-${manifest.target}`,
  ])
    if (!manifest.packages.some((item) => item.name === name))
      throw new Error(`Decoder artifact missing package: ${name}`);
  return manifest;
}

/** Run actual pixels in a clean child process; a cold require cannot test a lazy decoder. */
export function smokeCatalogImageDecoder(artifactDir) {
  const manifest = verifyCatalogImageDecoderArtifact(artifactDir);
  const host = `${process.platform}-${process.arch}`;
  const glibc =
    process.platform !== 'linux' || process.report.getReport().header.glibcVersionRuntime;
  if (manifest.target !== host || !glibc)
    throw new Error(
      `Decoder target requires its matching Linux/glibc or macOS runtime: ${manifest.target}`,
    );
  const source = [
    'import assert from "node:assert/strict";',
    'const sharp = (await import("#catalog-image-decoder")).default;',
    `assert.equal(sharp.versions.sharp, ${JSON.stringify(manifest.sharpVersion)});`,
    'const formats = ["jpeg","png","gif","webp"];',
    'for (const format of formats) {',
    'const bytes = await sharp({create:{width:24,height:16,channels:4,background:"#12345680"}}).toFormat(format).toBuffer();',
    'const image = sharp(bytes,{failOn:"warning"}); const meta = await image.metadata(); assert.equal(meta.width,24); assert.equal(meta.height,16);',
    'const out = await image.resize(1,1,{fastShrinkOnLoad:false}).raw().timeout({seconds:2}).toBuffer({resolveWithObject:true});',
    'assert.equal(out.data.length,out.info.channels); image.destroy();',
    '}',
    'await assert.rejects(sharp(Buffer.from([255,216,255,224,255,217]),{failOn:"warning"}).raw().toBuffer());',
    'console.log(JSON.stringify({sharpVersion:sharp.versions.sharp,formats,node:process.version,platform:process.platform,arch:process.arch}));',
  ].join('\n');
  // The script lives in the artifact package scope so #imports resolves there.
  const smokeFile = join(artifactDir, '.image-decoder-smoke.mjs');
  writeFileSync(smokeFile, source);
  let result;
  try {
    result = spawnSync(process.execPath, [smokeFile], {
      cwd: artifactDir,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, SHARP_IGNORE_GLOBAL_LIBVIPS: '1' },
      encoding: 'utf8',
      timeout: 15000,
    });
  } finally {
    rmSync(smokeFile, { force: true });
  }
  if (result.status !== 0) throw new Error(`Decoder artifact pixel smoke failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function packageDirectory(name, from) {
  const require = createRequire(from);
  for (const suffix of ['/package.json', '/package']) {
    try {
      return dirname(realpathSync(require.resolve(name + suffix)));
    } catch (error) {
      if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
    }
  }
  let dir = dirname(realpathSync(require.resolve(name)));
  while (dirname(dir) !== dir) {
    const file = join(dir, 'package.json');
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Missing decoder dependency: ${name}`);
}

function fileRecords(dir, root) {
  const rows = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) rows.push(...fileRecords(file, root));
    else {
      if (!entry.isFile()) throw new Error('Decoder artifact must contain only regular files');
      const bytes = readFileSync(file);
      rows.push({
        path: relative(root, file).split(sep).join('/'),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return rows;
}
