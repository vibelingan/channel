import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  type PublishedArticle,
  articleMediaPath,
  parsePublishedArticle,
} from '@vibelingan-channel/articles/publication';
import sharp from 'sharp';
import { z } from 'zod';
import { siteOrigin } from '../seo/page.ts';

export interface BlogSnapshot {
  schemaVersion: 1;
  purpose: 'public' | 'fixture';
  siteOrigin: string;
  total: number;
  articles: PublishedArticle[];
}
export interface BlogAsset {
  path: string;
  mimeType: string;
  bytes: Buffer;
}
export interface BlogBuild {
  snapshot: BlogSnapshot | null;
  assets: BlogAsset[];
}
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

export function decodeBlogSnapshot(input: unknown, site: string): BlogSnapshot {
  const value = z
    .object({
      schemaVersion: z.literal(1),
      purpose: z.enum(['public', 'fixture']),
      siteOrigin: z.string(),
      total: z.number().int().min(0).max(1000),
      articles: z.array(z.unknown()).max(1000),
    })
    .strict()
    .parse(input);
  if (siteOrigin(value.siteOrigin) !== siteOrigin(site))
    throw new Error('Blog snapshot SITE_URL mismatch');
  if (
    value.purpose === 'fixture' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(site).hostname)
  )
    throw new Error('Blog fixtures require a loopback site origin');
  if (value.total !== value.articles.length) throw new Error('Incomplete Blog snapshot');
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const images = new Set<string>();
  const articles = value.articles
    .map((input) => {
      const article = parsePublishedArticle(input);
      if (ids.has(article.articleId) || slugs.has(article.content.slug))
        throw new Error('Duplicate Blog article identity');
      ids.add(article.articleId);
      slugs.add(article.content.slug);
      for (const id of Object.keys(article.media)) {
        if (images.has(id)) throw new Error('Article media cannot belong to two articles');
        images.add(id);
      }
      return article;
    })
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) || a.content.slug.localeCompare(b.content.slug),
    );
  return {
    schemaVersion: 1,
    purpose: value.purpose,
    siteOrigin: siteOrigin(site),
    total: value.total,
    articles,
  };
}

/** Reads only an explicit accepted-publication export. It has no database credentials or network fallback. */
export async function readBlogBuild(
  site: string,
  inputFile = process.env.SEO_BLOG_SNAPSHOT ?? '',
): Promise<BlogBuild> {
  if (!inputFile) return { snapshot: null, assets: [] };
  const snapshotFile = await realpath(inputFile);
  const snapshot = decodeBlogSnapshot(
    JSON.parse((await boundedRead(snapshotFile, MAX_SNAPSHOT_BYTES)).toString('utf8')),
    site,
  );
  const assets: BlogAsset[] = [];
  let totalBytes = 0;
  for (const article of snapshot.articles)
    for (const [id, media] of Object.entries(article.media)) {
      const path = articleMediaPath(id, media);
      const root = resolve(dirname(snapshotFile), 'assets');
      const file = await realpath(resolve(root, `.${path}`));
      if (!file.startsWith(`${root}${sep}`))
        throw new Error('Blog media is outside the asset root');
      totalBytes += media.byteSize;
      if (totalBytes > MAX_MEDIA_BYTES) throw new Error('Blog media exceeds the build byte budget');
      const bytes = await boundedRead(file, 3 * 1024 * 1024);
      if (
        bytes.length !== media.byteSize ||
        createHash('sha256').update(bytes).digest('hex') !== media.sha256
      )
        throw new Error('Blog media bytes do not match the accepted snapshot');
      const metadata = await sharp(bytes, { limitInputPixels: 32_000_000 }).metadata();
      const format = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[
        media.mimeType
      ];
      if (
        metadata.format !== format ||
        metadata.width !== media.width ||
        metadata.height !== media.height ||
        (metadata.pages ?? 1) !== 1
      )
        throw new Error('Blog media type or dimensions do not match the accepted snapshot');
      assets.push({ path, mimeType: media.mimeType, bytes });
    }
  return { snapshot, assets };
}

async function boundedRead(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Blog input exceeds its byte budget');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size !== stat.size) throw new Error('Blog input changed during read');
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
