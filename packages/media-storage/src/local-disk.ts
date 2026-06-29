/**
 * Local-disk `MediaStorageAdapter` for development (local-server) and tests.
 * Writes objects under a base directory (e.g. `data/media/`), preserving the
 * same metadata shape as the CloudBase backend so handlers are backend-agnostic.
 *
 * `storageFileId` is `local-disk:<storagePath>`; the path is always resolved
 * back under `baseDir` and rejected if it escapes (no traversal).
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import {
  type MediaStorageAdapter,
  type PutMediaObjectInput,
  type StoredMediaObject,
  objectStoragePath,
} from './index.ts';

const LOCAL_DISK_PREFIX = 'local-disk:';

export class LocalDiskMediaStorage implements MediaStorageAdapter {
  constructor(private readonly baseDir: string) {}

  /** Resolve a storage path under baseDir, rejecting traversal outside it. */
  private resolveSafe(storagePath: string): string {
    const baseAbs = resolve(this.baseDir);
    const abs = resolve(baseAbs, storagePath);
    if (abs !== baseAbs && !abs.startsWith(baseAbs + sep)) {
      throw new Error(`media-storage(local-disk): path escapes base dir: ${storagePath}`);
    }
    return abs;
  }

  private toFileId(storagePath: string): string {
    return `${LOCAL_DISK_PREFIX}${storagePath}`;
  }

  private toStoragePath(fileId: string): string {
    return fileId.startsWith(LOCAL_DISK_PREFIX) ? fileId.slice(LOCAL_DISK_PREFIX.length) : fileId;
  }

  async putObject(input: PutMediaObjectInput): Promise<StoredMediaObject> {
    const storagePath = objectStoragePath(input);
    const abs = this.resolveSafe(storagePath);
    await mkdir(dirname(abs), { recursive: true });

    let byteSize: number;
    if (input.content instanceof Uint8Array) {
      // Buffer is a Uint8Array, so this covers both.
      const buf = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
      await writeFile(abs, buf);
      byteSize = buf.byteLength;
    } else {
      await pipeline(input.content, createWriteStream(abs));
      byteSize = (await stat(abs)).size;
    }

    return {
      storageProvider: 'local-disk',
      storageMode: 'local-disk',
      storageFileId: this.toFileId(storagePath),
      storagePath,
      byteSize,
    };
  }

  async getObjectAsBase64(fileId: string): Promise<{ body: string; byteSize?: number }> {
    const abs = this.resolveSafe(this.toStoragePath(fileId));
    const buf = await readFile(abs);
    return { body: buf.toString('base64'), byteSize: buf.byteLength };
  }

  async getTempUrl(fileId: string): Promise<{ url: string; expiresAt?: string }> {
    // Local files don't expire; return a stable file:// URL as the stub. Local
    // delivery actually flows through /api/images/:id, not this URL.
    const abs = this.resolveSafe(this.toStoragePath(fileId));
    return { url: pathToFileURL(abs).href };
  }

  async deleteObject(fileId: string): Promise<void> {
    const abs = this.resolveSafe(this.toStoragePath(fileId));
    await rm(abs, { force: true });
  }
}
