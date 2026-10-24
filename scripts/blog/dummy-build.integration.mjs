import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = process.cwd();
const input = mkdtempSync(join(tmpdir(), 'blog-release-build-'));
mkdirSync(join(root, 'apps/site/.astro'), { recursive: true });
const out = mkdtempSync(join(root, 'apps/site/.astro/blog-release-'));
try {
  execFileSync(
    join(root, 'apps/site/node_modules/.bin/tsx'),
    ['tests/fixtures/prepare-blog-release.ts', input],
    { cwd: root, stdio: 'inherit' },
  );
  execFileSync(
    join(root, 'apps/site/node_modules/.bin/astro'),
    ['build', '--config', 'astro.blog-dummy.config.ts', '--outDir', join(out, 'site')],
    {
      cwd: join(root, 'apps/site'),
      stdio: 'inherit',
      env: {
        ...process.env,
        SITE_URL: 'http://localhost:4321',
        SEO_BLOG_SNAPSHOT: '',
        SEO_BLOG_RELEASE_INPUT: join(input, 'release.json'),
        SEO_BLOG_TASK_ID: 'task-one',
      },
    },
  );
  const html = readFileSync(join(out, 'site/manufacturing-guide/index.html'), 'utf8');
  assert.match(html, /A useful manufacturing brief explains/);
  assert.match(html, /noindex,nofollow/);
  assert.match(html, /http:\/\/localhost:4321\/__blog-dummy\/manufacturing-guide\//);
  assert.match(html, /href="\/__blog-dummy\/"/);
  assert.doesNotMatch(html, /cloud:\/\/|createdBy|acceptedAt|deliveryId/);
  assert.ok(
    !readdirSync(join(out, 'site')).some((name) => /sitemap|robots|products|admin/.test(name)),
  );
  assert.match(
    readFileSync(join(out, 'site/index.html'), 'utf8'),
    /href="\/__blog-dummy\/manufacturing-guide\//,
  );
  console.log('[blog-release] Real Astro candidate build passed; no cloud writes.');
} finally {
  rmSync(input, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
}
