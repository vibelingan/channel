import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSiteUrl } from './local-site-readiness.mjs';

// This runner owns only temporary local files and child processes. It has no deploy entry.
const root = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), 'channel-blog-public-'));
// Astro 6 falls back to a shared .astro/.prerender for outDir outside cwd.
// Keep this output inside the site so another local test build cannot erase it.
await mkdir(join(root, 'apps/site/.astro'), { recursive: true });
const buildDirectory = await mkdtemp(join(root, 'apps/site/.astro/blog-public-'));
const siteDirectory = join(buildDirectory, 'site');
const fixtureDirectory = join(temporary, 'blog');
const catalogSnapshot = join(temporary, 'catalog.json');
const children = new Set();
const reservation = createServer();
await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
const address = reservation.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
await new Promise((done) => reservation.close(done));
const env = {
  ...process.env,
  SITE_URL: origin,
  SEO_CATALOG_SNAPSHOT: catalogSnapshot,
  SEO_CATALOG_API_ORIGIN: '',
  SEO_BLOG_SNAPSHOT: join(fixtureDirectory, 'snapshot.json'),
  PUBLIC_CB_PROXY: '0',
};
const bin = (directory, name) => join(root, directory, 'node_modules/.bin', name);

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', ...options });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
async function run(command, args, options) {
  const child = start(command, args, options);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Local Blog command failed (${code ?? signal})`)),
    );
  });
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}
async function build(stage) {
  console.log(`[blog-public] Build and inspect ${stage}`);
  await run(bin('apps/site', 'tsx'), [
    'tests/fixtures/prepare-blog-public.ts',
    fixtureDirectory,
    stage,
  ]);
  await run(bin('apps/site', 'astro'), ['build', '--outDir', siteDirectory], {
    cwd: join(root, 'apps/site'),
  });
  const manifest = JSON.parse(await readFile(join(siteDirectory, 'seo-manifest.json'), 'utf8'));
  assert.equal(manifest.entries.filter((entry) => entry.kind === 'product').length, 2);
  const sitemap = await readFile(join(siteDirectory, 'sitemap-0.xml'), 'utf8');
  assert.ok(!sitemap.includes('private-draft'));
  if (stage === 'empty') {
    assert.equal(manifest.entries.filter((entry) => entry.path.startsWith('/blog/')).length, 1);
    assert.equal(
      manifest.entries.find((entry) => entry.path === '/blog/').robots,
      'noindex,follow',
    );
    assert.ok(!sitemap.includes('/blog/'));
    const html = await readFile(join(siteDirectory, 'blog/index.html'), 'utf8');
    assert.ok(html.includes('No published articles'));
    await assert.rejects(readFile(join(siteDirectory, 'blog/manufacturing-guide/index.html')));
  } else if (stage === 'withdrawn') {
    await assert.rejects(readFile(join(siteDirectory, 'blog/manufacturing-guide/index.html')));
    assert.ok(!sitemap.includes('/blog/manufacturing-guide/'));
    assert.equal(manifest.entries.filter((entry) => entry.path.startsWith('/blog/')).length, 2);
  } else {
    const html = await readFile(join(siteDirectory, 'blog/manufacturing-guide/index.html'), 'utf8');
    assert.ok(html.includes('A useful manufacturing brief explains'));
    assert.ok(
      !/PRIVATE-DRAFT|cloud:\/\/|pending-upload|acceptedAt|deliveryId|createdBy/.test(html),
    );
    assert.ok(html.includes('2026-10-21T10:00:00.000Z'));
    assert.equal(
      html.includes('Updated acceptance checklist for the second public version.'),
      stage === 'updated',
    );
    assert.equal(manifest.entries.filter((entry) => entry.path.startsWith('/blog/')).length, 3);
  }
  return manifest;
}

try {
  await run(bin('apps/site', 'tsx'), ['apps/site/scripts/product-seo-fixture.ts', catalogSnapshot]);
  const initial = await build('initial');
  if (!process.argv.includes('--build-only')) {
    const child = start(
      bin('apps/site', 'astro'),
      ['preview', '--outDir', siteDirectory, '--host', '127.0.0.1', '--port', String(address.port)],
      { cwd: join(root, 'apps/site'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let startupError;
    child.on('error', (error) => {
      startupError = error;
    });
    const append = (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const deadline = Date.now() + 30000;
    while (
      !localSiteUrl(output) &&
      Date.now() < deadline &&
      child.exitCode === null &&
      !startupError
    )
      await new Promise((done) => setTimeout(done, 100));
    if (startupError) throw startupError;
    assert.equal(localSiteUrl(output), origin, 'Owned preview must use the reserved port');
    await run(
      bin('.', 'playwright'),
      [
        'test',
        'tests/e2e/blog-public-local.spec.ts',
        '--project=chromium',
        ...(process.argv.includes('--headed') ? ['--headed'] : []),
      ],
      {
        env: { ...env, E2E_SITE_URL: origin, E2E_BLOG_LOCAL_FIXTURE: '1' },
      },
    );
    await stop(child);
  }
  const updated = await build('updated');
  const pick = (manifest) =>
    manifest.entries.find((entry) => entry.path === '/blog/manufacturing-guide/');
  assert.notEqual(pick(initial).content.revision, pick(updated).content.revision);
  assert.equal(pick(updated).content.updatedAt, '2026-10-22T11:00:00.000Z');
  await build('withdrawn');
  await build('empty');
  await run(bin('apps/site', 'astro'), ['build', '--outDir', siteDirectory], {
    cwd: join(root, 'apps/site'),
    env: { ...env, SEO_BLOG_SNAPSHOT: '' },
  });
  const disabled = JSON.parse(await readFile(join(siteDirectory, 'seo-manifest.json'), 'utf8'));
  assert.equal(disabled.entries.filter((entry) => entry.path.startsWith('/blog/')).length, 0);
  await assert.rejects(readFile(join(siteDirectory, 'blog/index.html')));
  console.log(
    '[blog-public] Initial, updated, withdrawn, empty and disabled builds passed; no cloud resource was accessed.',
  );
} finally {
  await Promise.all([...children].map(stop));
  await rm(temporary, { recursive: true, force: true });
  await rm(buildDirectory, { recursive: true, force: true });
  console.log(`[blog-public] Removed owned temporary directory ${temporary}`);
}
