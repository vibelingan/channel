import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '@astrojs/compiler';
import type { Node as HtmlNode } from '@astrojs/compiler/types';
import { articleMediaPath } from '@vibelingan-channel/articles/publication';
import type { ManifestEntry } from '../seo/output-gate.ts';
import { articlePage, blogPage } from './page.ts';
import { readBlogBuild } from './snapshot.ts';

export async function validateBlogOutput(
  directory: string,
  origin: string,
  entries: ManifestEntry[],
  inputFile?: string,
): Promise<void> {
  const { snapshot, assets } = await readBlogBuild(origin, inputFile);
  const articles = snapshot?.articles ?? [];
  const expected = articles.length
    ? [
        blogPage(articles, origin, ''),
        ...articles.map((article) => articlePage(article, origin, '')),
      ]
    : [];
  const actual = entries.filter((entry) => entry.path.startsWith('/blog/'));
  if (
    actual.length !== expected.length ||
    expected.some((page) => !actual.some((entry) => entry.path === page.canonicalPath))
  )
    throw new Error('Blog output inventory does not match the accepted snapshot');
  for (const page of expected) {
    const entry = actual.find((entry) => entry.path === page.canonicalPath);
    if (
      entry?.content.source !== page.content.source ||
      entry.content.revision !== page.content.revision ||
      entry.content.updatedAt !== page.content.updatedAt
    )
      throw new Error('Blog output revision does not match the accepted snapshot');
  }
  for (const asset of assets) {
    const delivered = await readFile(join(directory, asset.path));
    if (
      createHash('sha256').update(delivered).digest('hex') !==
      createHash('sha256').update(asset.bytes).digest('hex')
    )
      throw new Error('Blog output image bytes do not match the accepted snapshot');
  }
  for (const article of articles) {
    const html = await readFile(
      join(directory, 'blog', article.content.slug, 'index.html'),
      'utf8',
    );
    const { ast } = await parse(html);
    const images: string[] = [];
    let bodies = 0;
    function visit(node: HtmlNode, insideBody = false) {
      let body = insideBody;
      if (node.type === 'element') {
        const attr = (name: string) =>
          node.attributes.find((attribute) => attribute.name === name)?.value;
        if (attr('class')?.split(/\s+/).includes('article-body')) {
          body = true;
          bodies++;
        }
        if (body && node.name === 'img') images.push(attr('src') ?? '');
      }
      if ('children' in node) for (const child of node.children) visit(child, body);
    }
    visit(ast);
    const expectedImages = Object.entries(article.media).map(([id, media]) =>
      articleMediaPath(id, media),
    );
    if (
      bodies !== 1 ||
      images.some((path) => !expectedImages.includes(path)) ||
      expectedImages.some((path) => !images.includes(path))
    )
      throw new Error('Blog body images do not match the accepted snapshot');
  }
}
