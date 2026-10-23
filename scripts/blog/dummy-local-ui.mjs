import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = process.cwd();
const live = process.env.E2E_BLOG_DUMMY_LIVE === '1';
let prepared = null;
if (live) {
  if (!process.env.BLOG_DUMMY_PRIVATE_DIR)
    throw new Error('Explicit private cloud preparation required');
  prepared = JSON.parse(
    await readFile(join(process.env.BLOG_DUMMY_PRIVATE_DIR, 'prepared.json'), 'utf8'),
  );
}
const dir = await mkdtemp(join(tmpdir(), 'blog-publication-ui-'));
const portServer = createServer();
const requestedPort = live ? Number(process.env.BLOG_DUMMY_ADMIN_PORT ?? 0) : 0;
if (
  !Number.isInteger(requestedPort) ||
  requestedPort < 0 ||
  requestedPort > 65535 ||
  (requestedPort > 0 && requestedPort < 1024)
)
  throw new Error('Explicit loopback test port must be between 1024 and 65535');
await new Promise((done, reject) => {
  portServer.once('error', reject);
  portServer.listen(requestedPort, '127.0.0.1', done);
});
const port = portServer.address().port;
await new Promise((done) => portServer.close(done));
const origin = `http://127.0.0.1:${port}`;
const children = [];
const bin = (owner, name) => join(root, owner, 'node_modules/.bin', name);
const env = {
  ...process.env,
  TCB_ENV: '',
  PORT: '0',
  LOCAL_DB_FILE: join(dir, 'db.json'),
  LOCAL_MEDIA_DIR: join(dir, 'media'),
  LOCAL_READY_FILE: join(dir, 'ready.json'),
  LOCAL_READY_TOKEN: 'owned-blog-p2-ui',
  LOCAL_ARTICLE_RELEASE_TESTS: '1',
  LOCAL_SITE_ORIGINS: origin,
  ADMIN_EMAIL: 'admin@channel.local',
  ADMIN_PASSWORD: 'admin',
  SITE_URL: origin,
  SEO_BLOG_SNAPSHOT: '',
  SEO_BLOG_RELEASE_INPUT: '',
};
function start(command, args, cwd, extra = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  return child;
}
let bridgePort = 0;
if (live) {
  const bridgeReservation = createServer();
  await new Promise((done) => bridgeReservation.listen(0, '127.0.0.1', done));
  bridgePort = bridgeReservation.address().port;
  await new Promise((done) => bridgeReservation.close(done));
}
const api = live
  ? start(process.execPath, ['scripts/blog/dummy-bridge.mjs'], root, {
      BLOG_DUMMY_BRIDGE_PORT: String(bridgePort),
      BLOG_DUMMY_ADMIN_ORIGIN: origin,
      BLOG_DUMMY_EXPECTED_SHA: prepared.codeSha,
      BLOG_DUMMY_BRIDGE_READY_FILE: env.LOCAL_READY_FILE,
    })
  : start(bin('apps/local-server', 'tsx'), ['src/main.ts'], join(root, 'apps/local-server'));
try {
  let ready;
  const deadline = Date.now() + (live ? 120000 : 30000);
  while (Date.now() < deadline) {
    try {
      ready = JSON.parse(await readFile(env.LOCAL_READY_FILE, 'utf8'));
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  if (
    !ready ||
    (live ? ready.codeSha !== prepared.codeSha : ready.token !== env.LOCAL_READY_TOKEN) ||
    api.exitCode !== null
  )
    throw new Error('Owned API failed readiness');
  const apiOrigin = `http://127.0.0.1:${ready.port}`;
  const catalog = join(dir, 'catalog.json');
  const fixture = start(
    bin('apps/site', 'tsx'),
    ['apps/site/scripts/product-seo-fixture.ts', catalog],
    root,
  );
  if ((await new Promise((done) => fixture.once('exit', done))) !== 0)
    throw new Error('Catalog fixture failed');
  await mkdir(join(root, 'apps/site/.astro'), { recursive: true });
  const buildDirectory = await mkdtemp(join(root, 'apps/site/.astro/blog-publication-ui-'));
  children.buildDirectory = buildDirectory;
  const build = start(
    bin('apps/site', 'astro'),
    ['build', '--outDir', join(buildDirectory, 'site')],
    join(root, 'apps/site'),
    { PUBLIC_API_BASE_URL: apiOrigin, SEO_CATALOG_SNAPSHOT: catalog },
  );
  if ((await new Promise((done) => build.once('exit', done))) !== 0)
    throw new Error('Admin production build failed');
  const site = start(
    bin('apps/site', 'astro'),
    [
      'preview',
      '--outDir',
      join(buildDirectory, 'site'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    join(root, 'apps/site'),
  );
  const siteDeadline = Date.now() + 30000;
  while (Date.now() < siteDeadline) {
    try {
      if ((await fetch(`${origin}/login`)).ok) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  const playwright = start(
    bin('.', 'playwright'),
    [
      'test',
      live
        ? 'tests/e2e/blog-dummy-live.spec.ts'
        : 'tests/e2e/admin-article-publication-local.spec.ts',
      '--project=chromium',
    ],
    root,
    { E2E_SITE_URL: origin, E2E_BLOG_PUBLICATION_LOCAL_DB: env.LOCAL_DB_FILE },
  );
  const code = await new Promise((done) => playwright.once('exit', done));
  if (code !== 0) throw new Error('Article publication UI acceptance failed');
} finally {
  for (const child of children)
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((done) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          done();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timeout);
          done();
        });
      });
    }
  if (children.buildDirectory) await rm(children.buildDirectory, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
}
