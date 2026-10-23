import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalUrl } from '../seo/page.ts';
import { validateBlogOutput } from './output.ts';
import { articleBody, articlePage, blogPage } from './page.ts';
import { publishedArticleFixture } from './testing.ts';

test('Blog build check rejects unexpected pages, omitted pages and a stale revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blog-output-'));
  try {
    const site = 'http://localhost:4321';
    const article = publishedArticleFixture();
    const entries = [blogPage([article], site, 'Brand'), articlePage(article, site, 'Brand')].map(
      (page) => ({
        ...page,
        path: page.canonicalPath,
        canonicalUrl: canonicalUrl(page.canonicalPath, site),
      }),
    );
    const file = join(dir, 'snapshot.json');
    await mkdir(join(dir, 'blog/manufacturing-guide'), { recursive: true });
    const html = join(dir, 'blog/manufacturing-guide/index.html');
    await writeFile(html, `<div class="article-body">${articleBody(article)}</div>`);
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        purpose: 'fixture',
        siteOrigin: site,
        total: 1,
        articles: [article],
      }),
    );
    await validateBlogOutput(dir, site, entries, file);
    await assert.rejects(validateBlogOutput(dir, site, entries, ''), /inventory/);
    await assert.rejects(validateBlogOutput(dir, site, entries.slice(0, 1), file), /inventory/);
    await assert.rejects(
      validateBlogOutput(
        dir,
        site,
        entries.map((entry) => ({ ...entry, content: { ...entry.content, revision: 'old' } })),
        file,
      ),
      /revision/,
    );
    await writeFile(html, '<div class="article-body"><img src="/api/private-image"></div>');
    await assert.rejects(validateBlogOutput(dir, site, entries, file), /images/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
