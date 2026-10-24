import { spawn } from 'node:child_process';
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
const origin = 'http://localhost:4321';
const api = `https://${policy.envId}.service.tcloudbase.com`;
const env = {
  ...process.env,
  SITE_URL: origin,
  PUBLIC_API_BASE_URL: api,
  PUBLIC_CB_PROXY: '0',
  PUBLIC_BLOG_WORKSPACE: '1',
  SEO_CATALOG_SNAPSHOT: join(directory, 'catalog.json'),
  SEO_CATALOG_API_ORIGIN: '',
  SEO_BLOG_SNAPSHOT: '',
  SEO_BLOG_RELEASE_INPUT: '',
  E2E_SITE_URL: origin,
  E2E_API_URL: api,
  E2E_BLOG_FORMAL_LIVE: '1',
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
    'apps/site/scripts/product-seo-fixture.ts',
    env.SEO_CATALOG_SNAPSHOT,
  ]);
  await run(
    join(root, 'apps/site/node_modules/.bin/astro'),
    ['build', '--outDir', join(directory, 'site')],
    join(root, 'apps/site'),
  );
  // Refuse an occupied port; never test an unrelated server.
  const { createServer } = await import('node:net');
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(4321, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => reservation.close(resolve));
  preview = start(
    join(root, 'apps/site/node_modules/.bin/astro'),
    ['preview', '--outDir', join(directory, 'site'), '--host', '127.0.0.1', '--port', '4321'],
    join(root, 'apps/site'),
  );
  let available = false;
  for (let i = 0; i < 100; i++) {
    if (preview.exitCode !== null) throw Error('Owned preview exited');
    try {
      available = (await fetch(`${origin}/login`)).ok;
      if (available) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!available) throw Error('Owned formal UI did not become ready');
  await run(join(root, 'node_modules/.bin/playwright'), [
    'test',
    'tests/e2e/blog-formal-live.spec.ts',
    '--project=chromium',
    '--retries=0',
  ]);
} finally {
  if (preview && preview.exitCode === null) {
    preview.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        preview.kill('SIGKILL');
        resolve();
      }, 3000);
      preview.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await rm(directory, { recursive: true, force: true });
}
