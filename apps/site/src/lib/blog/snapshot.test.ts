import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { articleContentHash } from '@vibelingan-channel/articles/drafts';
import { articleMediaPath } from '@vibelingan-channel/articles/publication';
import sharp from 'sharp';
import { decodeBlogSnapshot, readBlogBuild } from './snapshot.ts';
import { publishedArticleFixture } from './testing.ts';

const site = 'http://localhost:4321';
const snapshot = () => ({
  schemaVersion: 1,
  purpose: 'fixture',
  siteOrigin: site,
  total: 1,
  articles: [publishedArticleFixture()],
});

test('snapshot requires complete accepted inventory, unique identities and the correct origin', () => {
  assert.equal(decodeBlogSnapshot(snapshot(), site).articles.length, 1);
  assert.equal(
    decodeBlogSnapshot(
      { ...snapshot(), purpose: 'public', siteOrigin: 'https://example.com' },
      'https://example.com',
    ).total,
    1,
  );
  const value = snapshot();
  for (const bad of [
    { ...value, total: 2 },
    { ...value, siteOrigin: 'https://other.example' },
    { ...value, total: 2, articles: [value.articles[0], value.articles[0]] },
    {
      ...value,
      total: 2,
      articles: [value.articles[0], { ...value.articles[0], articleId: 'other-id' }],
    },
    { ...value, drafts: ['secret'] },
    { ...value, articles: [{ ...value.articles[0], status: 'candidate' }] },
  ])
    assert.throws(() => decodeBlogSnapshot(bad, site));
  assert.throws(() =>
    decodeBlogSnapshot({ ...value, siteOrigin: 'https://example.com' }, 'https://example.com'),
  );
});

test('absent input leaves Blog disabled, but explicit missing or corrupt input fails', async () => {
  assert.equal((await readBlogBuild(site, '')).snapshot, null);
  await assert.rejects(readBlogBuild(site, '/missing/blog.json'));
  const dir = await mkdtemp(join(tmpdir(), 'blog-invalid-'));
  try {
    const path = join(dir, 'snapshot.json');
    await writeFile(path, '{}');
    await assert.rejects(readBlogBuild(site, path));
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1, ' '));
    await assert.rejects(readBlogBuild(site, path), /byte budget/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('build reads exact image bytes and rejects missing, modified or escaping assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blog-assets-'));
  const outside = await mkdtemp(join(tmpdir(), 'blog-outside-'));
  try {
    const bytes = await sharp({
      create: { width: 12, height: 8, channels: 3, background: '#123456' },
    })
      .webp()
      .toBuffer();
    const media = {
      mimeType: 'image/webp' as const,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.length,
      width: 12,
      height: 8,
    };
    const article = publishedArticleFixture();
    article.content.body.document.content.push({
      type: 'articleImage',
      attrs: { mediaId: 'image-one', alt: 'An example product', caption: '', align: 'center' },
    });
    article.contentHash = articleContentHash(article.content);
    article.media = { 'image-one': media };
    const path = join(dir, 'snapshot.json');
    await writeFile(path, JSON.stringify({ ...snapshot(), articles: [article] }));
    await assert.rejects(readBlogBuild(site, path));
    const file = join(dir, 'assets', articleMediaPath('image-one', media));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    const built = await readBlogBuild(site, path);
    assert.deepEqual(built.assets[0]?.bytes, bytes);
    await writeFile(
      path,
      JSON.stringify({
        ...snapshot(),
        articles: [{ ...article, media: { 'image-one': { ...media, width: 13 } } }],
      }),
    );
    await assert.rejects(readBlogBuild(site, path), /dimensions/);
    await writeFile(path, JSON.stringify({ ...snapshot(), articles: [article] }));
    await writeFile(file, Buffer.from('different bytes'));
    await assert.rejects(readBlogBuild(site, path));
    await rm(file);
    const other = join(outside, 'image.webp');
    await writeFile(other, bytes);
    await symlink(other, file);
    await assert.rejects(readBlogBuild(site, path), /outside/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('explicit candidate build accepts only its task; it cannot masquerade as a public export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blog-candidate-'));
  try {
    const {
      status: _status,
      deliveryId: _deliveryId,
      acceptedAt: _acceptedAt,
      ...data
    } = publishedArticleFixture();
    const file = join(dir, 'release.json');
    await writeFile(
      file,
      JSON.stringify({
        siteOrigin: site,
        release: {
          schemaVersion: 1,
          purpose: 'article-release',
          taskId: 'task-one',
          operation: 'publish',
          articleId: data.articleId,
          revision: data.revision,
          accepted: [],
          candidate: { ...data, status: 'candidate', taskId: 'task-one' },
        },
      }),
    );
    const build = await readBlogBuild(site, '', file, 'task-one');
    assert.equal(build.snapshot?.articles[0]?.status, 'candidate');
    await assert.rejects(readBlogBuild(site, '', file, 'other-task'));
    await assert.rejects(readBlogBuild(site, file));
    await assert.rejects(readBlogBuild(site, file, file, 'task-one'), /not both/);
    await assert.rejects(readBlogBuild('https://example.com', '', file, 'task-one'), /SITE_URL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
