import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { prepareArticleBuild } from '@vibelingan-channel/articles/build';
import { ArticleMediaRecordSchema } from '@vibelingan-channel/articles/media';
import { articleMediaPath } from '@vibelingan-channel/articles/publication';
import { z } from 'zod';
import type { ArticleDatabase } from './article-repository.ts';
export async function writeBlogBuildAssets({
  db,
  sdk,
  input,
  directory,
  taskId,
  assertFileId,
}: {
  db: ArticleDatabase;
  sdk: { downloadFile(options: { fileID: string }): Promise<{ fileContent?: unknown }> };
  input: { release: unknown };
  directory: string;
  taskId: string;
  assertFileId: (fileId: string) => void;
}) {
  let total = 0;
  for (const article of prepareArticleBuild(input.release, taskId)) {
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
