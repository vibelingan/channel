import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { decodeBlogSnapshot } from '../../apps/site/src/lib/blog/snapshot.ts';
import { publishedArticleFixture } from '../../apps/site/src/lib/blog/testing.ts';
import { articleContentHash, createArticleDraft } from '../../packages/articles/src/drafts.ts';
import { articleMediaPath } from '../../packages/articles/src/publication.ts';

const [directory, stage = 'initial'] = process.argv.slice(2);
if (!directory || !['initial', 'updated', 'withdrawn', 'empty'].includes(stage))
  throw new Error('Provide a fixture directory and initial/updated/withdrawn stage');
const site = process.env.SITE_URL || 'http://localhost:4321';
const article = publishedArticleFixture();
const bytes = await readFile(resolve('apps/site/public/media/factory-oem.webp'));
const media = {
  mimeType: 'image/webp' as const,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  byteSize: bytes.length,
  width: 1228,
  height: 718,
};
article.content.body.document.content.push({
  type: 'articleImage',
  attrs: {
    mediaId: 'fixture-factory',
    alt: 'Factory building used in this local article example',
    caption: 'Local fixture using an existing public site image.',
    align: 'center',
  },
});
article.media = { 'fixture-factory': media };
if (stage === 'updated') {
  article.revision = 2;
  article.modifiedAt = '2026-10-22T11:00:00.000Z';
  article.acceptedAt = '2026-10-22T11:01:00.000Z';
  article.content.body.document.content.push({
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [
      {
        type: 'text',
        text: 'Updated acceptance checklist for the second public version.',
        marks: [],
      },
    ],
  });
}
article.contentHash = articleContentHash(article.content);
const other = publishedArticleFixture('reference-sample');
other.content.title = 'Planning a reference sample';
other.content.excerpt = 'Use an agreed reference sample to confirm the production requirements.';
other.contentHash = articleContentHash(other.content);
const articles = stage === 'empty' ? [] : stage === 'withdrawn' ? [other] : [article, other];
const snapshot = decodeBlogSnapshot(
  { schemaVersion: 1, purpose: 'fixture', siteOrigin: site, total: articles.length, articles },
  site,
);
await mkdir(directory, { recursive: true });
const asset = join(directory, 'assets', articleMediaPath('fixture-factory', media));
await mkdir(dirname(asset), { recursive: true });
await writeFile(asset, bytes);
await writeFile(join(directory, 'snapshot.json'), JSON.stringify(snapshot));
await writeFile(
  join(directory, 'private-draft.json'),
  JSON.stringify(
    createArticleDraft({
      id: 'never-public-draft',
      editorId: 'test-admin',
      now: '2026-10-22T12:00:00.000Z',
      content: {
        ...article.content,
        title: 'PRIVATE-DRAFT-DO-NOT-PUBLISH',
        slug: 'private-draft-do-not-publish',
      },
    }),
  ),
);
console.log(`Prepared ${snapshot.total} loopback-only Blog fixture articles (${stage}).`);
