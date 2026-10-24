import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type ArticlePageData, prepareArticleBuild } from '@vibelingan-channel/articles/build';
import { ArticleMediaRecordSchema } from '@vibelingan-channel/articles/media';
import { articleMediaPath } from '@vibelingan-channel/articles/publication';
import { z } from 'zod';
import type { ArticleDatabase } from './article-repository.ts';
interface AssetOptions {
  db: ArticleDatabase;
  sdk: { downloadFile(options: { fileID: string }): Promise<{ fileContent?: unknown }> };
  directory: string;
  assertFileId: (fileId: string) => void;
}
export async function writeBlogBuildAssets(
  options: AssetOptions & {
    input: { release: unknown };
    taskId: string;
  },
) {
  return writeBlogArticleAssets({
    ...options,
    articles: prepareArticleBuild(options.input.release, options.taskId),
  });
}
/** Resolve verified public image bytes for accepted snapshots and frozen candidates alike. */
export async function writeBlogArticleAssets({
  db,
  sdk,
  articles,
  directory,
  assertFileId,
}: AssetOptions & { articles: ArticlePageData[] }) {
  let total = 0;
  for (const article of articles) {
    for (const [id, media] of Object.entries(article.media)) {
      const raw = await db.runTransaction(async (tx) =>
        tx.collection('articleMedia').doc(id).get(),
      );
      const value = z
        .object({ data: z.record(z.unknown()) })
        .passthrough()
        .parse(raw).data;
      const { _id, ...record } = value;
      const active = ArticleMediaRecordSchema.parse(record);
      if (
        _id !== id ||
        active.id !== id ||
        active.articleId !== article.articleId ||
        active.status !== 'active' ||
        active.checksumSha256 !== media.sha256 ||
        active.byteSize !== media.byteSize ||
        active.mimeType !== media.mimeType ||
        active.width !== media.width ||
        active.height !== media.height
      )
        throw new Error('Frozen Blog media identity changed');
      assertFileId(active.storage.storageFileId);
      const response = await sdk.downloadFile({ fileID: active.storage.storageFileId });
      const bytes = response.fileContent;
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.length !== media.byteSize ||
        createHash('sha256').update(bytes).digest('hex') !== media.sha256 ||
        total + bytes.length > 64 * 1024 * 1024
      )
        throw new Error('Frozen Blog media bytes changed');
      total += bytes.length;
      const file = join(directory, 'assets', articleMediaPath(id, media));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    }
  }
}
