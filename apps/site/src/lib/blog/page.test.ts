import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleContentHash } from '@vibelingan-channel/articles/drafts';
import { articlePage, articleSummary, blogPage } from './page.ts';
import { publishedArticleFixture } from './testing.ts';

test('article metadata, links and schema share an identity and stable publication dates', () => {
  const article = publishedArticleFixture();
  const page = articlePage(article, 'https://example.com', 'Example brand');
  assert.equal(page.canonicalPath, '/blog/manufacturing-guide/');
  assert.equal(page.content.updatedAt, article.modifiedAt);
  const schema = page.schemaNodes.find((node) => node['@type'] === 'Article');
  assert.equal(schema?.url, 'https://example.com/blog/manufacturing-guide/');
  assert.equal(schema?.datePublished, article.publishedAt);
  assert.equal(schema?.dateModified, article.modifiedAt);
  assert.equal(page.description, article.content.excerpt);
  assert.deepEqual(
    articlePage(structuredClone(article), 'https://example.com', 'Example brand'),
    page,
  );
});

test('fallback summary comes from the body and explicit SEO fields override it', () => {
  const article = publishedArticleFixture();
  article.content.excerpt = '';
  article.contentHash = articleContentHash(article.content);
  assert.match(articleSummary(article), /^A useful manufacturing brief/);
  article.content.seoDescription = 'Explicit search description';
  article.content.seoTitle = 'Explicit search title';
  const page = articlePage(article, 'https://example.com', 'Brand');
  assert.equal(page.description, 'Explicit search description');
  assert.equal(page.title, 'Explicit search title | Brand');
});

test('collection revision and last modified derive from public content, never the build clock', () => {
  const article = publishedArticleFixture();
  assert.deepEqual(
    blogPage([article], 'https://example.com', 'Brand'),
    blogPage([structuredClone(article)], 'https://example.com', 'Brand'),
  );
  assert.equal(
    blogPage([article], 'https://example.com', 'Brand').content.updatedAt,
    article.modifiedAt,
  );
  assert.equal(blogPage([], 'https://example.com', 'Brand').robots, 'noindex,follow');
});
