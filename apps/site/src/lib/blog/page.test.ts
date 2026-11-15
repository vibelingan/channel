import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleContentHash } from '@vibelingan-channel/articles/drafts';
import type { ArticleWebPresentation } from '@vibelingan-channel/articles/web-media';
import { articleBody, articlePage, articleSummary, blogPage, publicBlogLocation } from './page.ts';
import { publishedArticleFixture } from './testing.ts';

function imageFixture() {
  const article = publishedArticleFixture();
  article.content.body.document.content.unshift({
    type: 'articleImage',
    attrs: {
      mediaId: 'article-image',
      alt: 'Headphones beside a notebook',
      caption: 'Enquiry preparation',
      align: 'center',
    },
  });
  article.media['article-image'] = {
    mimeType: 'image/png',
    sha256: 'a'.repeat(64),
    byteSize: 2_000_000,
    width: 1536,
    height: 1024,
  };
  article.contentHash = articleContentHash(article.content);
  const presentation: ArticleWebPresentation = {
    media: {
      'article-image': {
        sourceSha256: 'a'.repeat(64),
        url: `/media/articles/article-image/web-v1-${'b'.repeat(64)}.webp`,
        mimeType: 'image/webp',
        width: 1280,
        height: 853,
        byteSize: 90_000,
        sha256: 'b'.repeat(64),
      },
    },
  };
  return { article, presentation };
}

test('verified presentation changes only display bytes and dimensions, preserving publication and copy', () => {
  const { article, presentation } = imageFixture();
  const before = structuredClone(article);
  const location = { ...publicBlogLocation, mediaPrefix: '/blog' };
  const html = articleBody(article, location, presentation);
  assert(html.includes(`/blog/media/articles/article-image/web-v1-${'b'.repeat(64)}.webp`));
  assert.match(html, /width="1280" height="853"/);
  assert.match(html, /alt="Headphones beside a notebook"/);
  assert.match(html, /Enquiry preparation/);
  assert.match(html, /article-image-center/);
  assert(!html.includes(`${'a'.repeat(64)}.png`));
  assert.deepEqual(article, before);
  const page = articlePage(article, 'https://example.com', 'Brand', location, presentation);
  assert.equal(page.content.revision, article.contentHash);
  assert.equal(page.content.updatedAt, article.modifiedAt);
  assert.deepEqual(page.schemaNodes.find((node) => node['@type'] === 'Article')?.image, [
    `https://example.com/blog/media/articles/article-image/web-v1-${'b'.repeat(64)}.webp`,
  ]);
});

test('absent or partial presentation uses the unchanged original image address', () => {
  const { article } = imageFixture();
  const html = articleBody(article, publicBlogLocation, { media: {} });
  assert(html.includes(`/media/articles/article-image/${'a'.repeat(64)}.png`));
  assert.match(html, /width="1536" height="1024"/);
});

test('a stale source mapping is rejected by both body and metadata rendering', () => {
  const { article, presentation } = imageFixture();
  presentation.media['article-image'].sourceSha256 = 'c'.repeat(64);
  assert.throws(() => articleBody(article, publicBlogLocation, presentation));
  assert.throws(() =>
    articlePage(article, 'https://example.com', 'Brand', publicBlogLocation, presentation),
  );
});

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

test('a site-brand byline is an organization, while named authors remain people', () => {
  const article = publishedArticleFixture();
  article.content.authorName = 'Example brand';
  const schema = articlePage(article, 'https://example.com', 'Example brand').schemaNodes.find(
    (node) => node['@type'] === 'Article',
  );
  assert.deepEqual(schema?.author, { '@type': 'Organization', name: 'Example brand' });
  article.content.authorName = 'Named editor';
  const person = articlePage(article, 'https://example.com', 'Example brand').schemaNodes.find(
    (node) => node['@type'] === 'Article',
  );
  assert.deepEqual(person?.author, { '@type': 'Person', name: 'Named editor' });
});
