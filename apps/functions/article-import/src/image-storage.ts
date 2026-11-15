import { createHash } from 'node:crypto';
import type { ArticleImageStorage } from '@vibelingan-channel/articles/import-media';
import { ARTICLE_IMAGE_MAX_BYTES } from '@vibelingan-channel/articles/media';
import type { MediaStorageAdapter } from '@vibelingan-channel/media-storage';
import { signatureMatchesMime, sniffMagicBytes } from '@vibelingan-channel/shared';
import { imageSize } from 'image-size';

/** Cloud identity stays in the function; callers receive only a single-object PUT grant. */
export function createArticleImageStorage(adapter: MediaStorageAdapter): ArticleImageStorage {
  return {
    async mint(path) {
      const c = await adapter.getUploadCredential(path);
      return {
        storageFileId: c.storageFileId,
        storagePath: path,
        upload: { method: c.method, url: c.uploadUrl, headers: c.headers },
      };
    },
    async read(id) {
      const object = await adapter.getObjectAsBase64(id, {
        maxBytes: ARTICLE_IMAGE_MAX_BYTES,
        timeoutMs: 15000,
      });
      if (object.body.length > Math.ceil(ARTICLE_IMAGE_MAX_BYTES / 3) * 4)
        throw Error('Image exceeds byte limit');
      const bytes = Buffer.from(object.body, 'base64');
      if (bytes.toString('base64') !== object.body || bytes.length > ARTICLE_IMAGE_MAX_BYTES)
        throw Error('Invalid image encoding');
      return bytes;
    },
    validate(bytes, file) {
      if (
        bytes.length !== file.byteSize ||
        createHash('sha256').update(bytes).digest('hex') !== file.checksumSha256 ||
        !signatureMatchesMime(sniffMagicBytes(bytes), file.mimeType)
      )
        throw Error('Image bytes do not match');
      const size = imageSize(bytes);
      if (!size.width || !size.height || !['png', 'jpg', 'webp'].includes(size.type ?? ''))
        throw Error('Invalid image dimensions');
      return { width: size.width, height: size.height };
    },
    async seal(id, checksum, bytes, checkpoint) {
      const stored = await adapter.putObject(
        {
          namespace: 'articles',
          logicalId: id,
          fileName: `${checksum}.image`,
          mimeType: 'application/octet-stream',
          content: bytes,
        },
        {
          beforeWrite: async (value) =>
            checkpoint({ storageFileId: value.storageFileId, storagePath: value.storagePath }),
        },
      );
      return { storageFileId: stored.storageFileId, storagePath: stored.storagePath };
    },
  };
}
