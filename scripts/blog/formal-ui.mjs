import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
const policy = assertBlogBootstrapInvocation(process.env);
const ready = JSON.parse(await readFile('output/blog-bootstrap/result.json', 'utf8'));
if (
  ready.codeSha !== process.env.GITHUB_SHA ||
  !ready.configurationUnchanged ||
  !process.env.E2E_ADMIN_PASSWORD ||
  !process.env.E2E_ADMIN_EMAIL
)
  throw new Error('Verified formal admin installation and real administrator credentials required');
const root = process.cwd();
await mkdir('apps/site/.astro', { recursive: true });
const directory = await mkdtemp(join(root, 'apps/site/.astro/formal-article-ui-'));
const origin = policy.siteOrigin;
const api = `https://${policy.envId}.service.tcloudbase.com`;
const env = {
  ...process.env,
  SITE_URL: origin,
  PUBLIC_API_BASE_URL: api,
  PUBLIC_CB_PROXY: '0',
  PUBLIC_BLOG_WORKSPACE: '1',
  SEO_CATALOG_SNAPSHOT: join(directory, 'catalog.json'),
  SEO_CATALOG_API_ORIGIN: policy.siteOrigin,
  SEO_BLOG_SNAPSHOT: '',
  SEO_BLOG_RELEASE_INPUT: '',
  E2E_SITE_URL: origin,
  E2E_API_URL: api,
  E2E_BLOG_FORMAL_LIVE: '1',
  E2E_BLOG_FORMAL_PREVIEW: '1',
  E2E_RECORD_ARTIFACTS: '0',
};
let preview;
function start(command, args, cwd = root) {
  return spawn(command, args, { cwd, env, stdio: 'inherit' });
}
function run(command, args, cwd) {
  const child = start(command, args, cwd);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(Error(`Formal UI process failed (${code})`)),
    );
  });
}
try {
  await run(join(root, 'apps/site/node_modules/.bin/tsx'), [
    'apps/site/scripts/prepare-product-seo.ts',
    env.SEO_CATALOG_SNAPSHOT,
  ]);
  await run(
    join(root, 'apps/site/node_modules/.bin/astro'),
    ['build', '--outDir', join(directory, 'site')],
    join(root, 'apps/site'),
  );
  const key = join(directory, 'preview.key');
  const certificate = join(directory, 'preview.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-days',
      '1',
      '-subj',
      '/CN=supplychainsai.com',
      '-addext',
      'subjectAltName=DNS:supplychainsai.com',
    ],
    { stdio: 'ignore', timeout: 30000 },
  );
  const readyFile = join(directory, 'preview-ready.json');
  // The disposable runner binds 443; this process receives no login or cloud credentials.
  preview = spawn(
    'sudo',
    [
      '-n',
      '/usr/bin/env',
      'GITHUB_ACTIONS=true',
      process.execPath,
      join(root, 'scripts/blog/formal-preview.mjs'),
      join(directory, 'site'),
      key,
      certificate,
      readyFile,
    ],
    {
      cwd: root,
      detached: true,
      env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true' },
      stdio: 'inherit',
    },
  );
  let available = false;
  for (let i = 0; i < 100; i++) {
    if (preview.exitCode !== null) throw Error('Owned HTTPS preview exited');
    try {
      const ready = JSON.parse(await readFile(readyFile, 'utf8'));
      available = ready.port === 443 && ready.root === join(directory, 'site');
      if (available) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!available) throw Error('Owned HTTPS preview did not become ready');
  await run(join(root, 'node_modules/.bin/playwright'), [
    'test',
    'tests/e2e/blog-formal-live.spec.ts',
    '--project=chromium',
    '--retries=0',
  ]);
} finally {
  if (preview && preview.exitCode === null && preview.pid) {
    try {
      execFileSync('sudo', ['-n', 'kill', '-TERM', '--', `-${preview.pid}`], {
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {}
    await new Promise((resolve) => {
      if (preview.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 3000);
      preview.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await rm(directory, { recursive: true, force: true });
}
