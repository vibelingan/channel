/** Isolated loopback test transport. Never used by a cloud function or default local server. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { ARTICLE_IMAGE_MAX_BYTES } from '@vibelingan-channel/articles/media';
import type { UploadCredential } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import express from 'express';

export class ArticleUploadTestTransport extends LocalDiskMediaStorage {
  private credentials = new Map<string, { path: string; expires: number }>();
  constructor(
    private readonly directory: string,
    private readonly origin: () => string,
  ) {
    super(directory);
  }
  override async getUploadCredential(path: string): Promise<UploadCredential> {
    if (!path.startsWith('articles/'))
      throw new Error('Test uploads are limited to article media.');
    const token = randomUUID();
    this.credentials.set(token, { path, expires: Date.now() + 15 * 60 * 1000 });
    const origin = this.origin();
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
      throw new Error('Loopback test origin unavailable');
    return {
      method: 'PUT',
      uploadUrl: `${origin}/__local-test/article-uploads/${token}`,
      storageFileId: `local-disk:${path}`,
      headers: {
        Signature: token,
        'x-cos-security-token': token,
        'x-cos-meta-fileid': `local-disk:${path}`,
        authorization: token,
        key: encodeURIComponent(path),
      },
    };
  }
  register(app: express.Express) {
    app.put(
      '/__local-test/article-uploads/:token',
      express.raw({ type: () => true, limit: ARTICLE_IMAGE_MAX_BYTES }),
      async (req, res) => {
        const token = req.params.token;
        const credential = this.credentials.get(token);
        if (
          !credential ||
          credential.expires <= Date.now() ||
          req.get('Signature') !== token ||
          req.get('authorization') !== token ||
          req.get('x-cos-security-token') !== token ||
          req.get('key') !== encodeURIComponent(credential.path) ||
          req.get('x-cos-meta-fileid') !== `local-disk:${credential.path}`
        ) {
          res.sendStatus(403);
          return;
        }
        const base = resolve(this.directory);
        const file = resolve(base, credential.path);
        if (!file.startsWith(base + sep) || !Buffer.isBuffer(req.body)) {
          res.sendStatus(400);
          return;
        }
        try {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, req.body);
          res.status(200).end();
        } catch {
          res.sendStatus(500);
        }
      },
    );
  }
}
