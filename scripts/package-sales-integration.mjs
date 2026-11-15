import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const WORKSPACE = '@vibelingan-channel/fn-sales-integration';
const INPUTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'apps/functions',
  'packages',
];
const FILES = ['index.js', 'reconcile.js', 'scf_bootstrap', 'package.json'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Build committed input in a disposable directory, never from the caller's dirty tree. */
export function packageSalesIntegration({ root, sha, output, run = execFileSync }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('Use a full 40-character commit SHA');
  root = resolve(root);
  output = resolve(output);
  if (existsSync(output)) throw new Error('Output must be a new directory');
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'PNPM_HOME']
      .filter((key) => typeof process.env[key] === 'string')
      .map((key) => [key, process.env[key]]),
  );
  const command = (file, args, cwd = root) =>
    run(file, args, {
      cwd,
      env: { ...env, TZ: 'UTC' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  if (command('git', ['rev-parse', '--verify', `${sha}^{commit}`]).trim() !== sha)
    throw new Error('Commit identity did not match');
  const tree = command('git', ['ls-tree', '-rz', sha, '--', ...INPUTS])
    .split('\0')
    .filter(Boolean);
  if (!tree.length || tree.some((entry) => !/^100(?:644|755) blob /.test(entry)))
    throw new Error('Build inputs must be committed regular files');
  const temporary = mkdtempSync(join(tmpdir(), 'channel-sales-package-'));
  try {
    const checkout = join(temporary, 'source');
    mkdirSync(checkout);
    const archive = join(temporary, 'source.tar');
    command('git', ['archive', '--format=tar', '--output', archive, sha, ...INPUTS]);
    command('tar', ['-xf', archive, '-C', checkout]);
    const rootPackage = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
    const pnpmVersion = command('pnpm', ['--version'], checkout).trim();
    if (rootPackage.packageManager !== `pnpm@${pnpmVersion}`)
      throw new Error('Installed pnpm must match the committed packageManager');
    const functionPackage = JSON.parse(
      readFileSync(join(checkout, 'apps/functions/sales-integration/package.json'), 'utf8'),
    );
    if (functionPackage.name !== WORKSPACE) throw new Error('Unexpected Sales workspace');
    command('pnpm', ['--filter', `${WORKSPACE}...`, 'install', '--frozen-lockfile'], checkout);
    for (const script of ['build', 'package:artifact', 'check:artifact'])
      command('pnpm', ['--filter', WORKSPACE, script], checkout);
    const artifact = join(checkout, 'apps/functions/sales-integration/dist/package');
    if (JSON.stringify(readdirSync(artifact).sort()) !== JSON.stringify([...FILES].sort()))
      throw new Error('Sales package contains unexpected files');
    const committedAt = Number(command('git', ['show', '-s', '--format=%ct', sha]).trim());
    if (!Number.isSafeInteger(committedAt) || committedAt < 315532800)
      throw new Error('Invalid commit timestamp');
    const files = FILES.map((name) => {
      const path = join(artifact, name);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        throw new Error('Sales package entries must be regular files');
      chmodSync(path, name === 'scf_bootstrap' ? 0o755 : 0o644);
      utimesSync(path, committedAt, committedAt);
      const bytes = readFileSync(path);
      return { name, bytes: bytes.length, sha256: sha256(bytes) };
    });
    const zipName = `sales-integration-${sha}.zip`;
    const zip = join(temporary, zipName);
    command('zip', ['-q', '-X', zip, ...FILES], artifact);
    const manifest = {
      schemaVersion: 1,
      function: 'sales-integration',
      commit: sha,
      runtime: 'Nodejs20.19',
      type: 'HTTP',
      port: 9000,
      build: { node: process.version, pnpm: pnpmVersion, source: 'git-archive' },
      zip: { name: zipName, bytes: lstatSync(zip).size, sha256: sha256(readFileSync(zip)) },
      files,
    };
    // Exclusive creation prevents overwriting an existing release or backup directory.
    mkdirSync(output, { mode: 0o700 });
    cpSync(artifact, join(output, 'package'), { recursive: true });
    cpSync(zip, join(output, zipName));
    chmodSync(join(output, zipName), 0o600);
    writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    return { ...manifest, output };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { sha: { type: 'string' }, output: { type: 'string' } },
  });
  if (!values.sha || !values.output)
    throw new Error('Usage: --sha FULL_SHA --output NEW_DIRECTORY');
  console.log(
    JSON.stringify(
      packageSalesIntegration({
        root: dirname(fileURLToPath(new URL('../package.json', import.meta.url))),
        sha: values.sha,
        output: values.output,
      }),
      null,
      2,
    ),
  );
}
