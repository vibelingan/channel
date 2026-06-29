/**
 * CloudBase `MediaStorageAdapter` — the production backend.
 *
 * It deliberately does NOT `import 'wx-server-sdk'`. Instead the caller (a cloud
 * function's entry file) passes the already-initialised `cloud` SDK in. Two
 * reasons:
 *   1. This package then imports nothing CloudBase-specific, so it can never be
 *      pulled into a browser bundle (design §20.4 exit criterion).
 *   2. It avoids duplicating the hand-written `wx-server-sdk` type-stub that
 *      lives in `@vibelingan-channel/db` (the SDK ships no types). The function
 *      calls db's `initCloudBase(env)` once, then
 *      `setMediaStorage(createCloudBaseMediaStorage(cloud))`.
 *
 * Storage signatures were verified against the installed @cloudbase/node-sdk@2.10.0
 * (wrapped by wx-server-sdk@3.0.4) in MIU-00 — see docs/IMAGE_UPLOAD_EXECUTION.md
 * §"Upload-credential mechanism" / design §24.3.
 */
import {
  type MediaStorageAdapter,
  type PutMediaObjectInput,
  type StoredMediaObject,
  objectStoragePath,
} from './index.ts';

/**
 * The exact subset of the CloudBase server SDK this adapter uses. `wx-server-sdk`'s
 * default export structurally satisfies this; the signatures match the installed
 * `@cloudbase/node-sdk@2.10.0` (notably `getTempFileURL`'s `fileList` is a
 * `(string | { fileID, maxAge? })[]` union — design §24.3 C1).
 */
export interface CloudBaseStorageSdk {
  uploadFile(options: {
    cloudPath: string;
    fileContent: Buffer | Uint8Array | NodeJS.ReadableStream;
  }): Promise<{ fileID: string }>;
  getTempFileURL(options: {
    fileList: (string | { fileID: string; maxAge?: number })[];
  }): Promise<{ fileList: { fileID: string; tempFileURL: string; code?: string }[] }>;
  // `fileContent` is optional to match the installed SDK (a failed download
  // yields no content); getObjectAsBase64 guards it. `Cloud`'s narrower
  // `{ fileContent: Buffer }` is still assignable here.
  downloadFile(options: { fileID: string }): Promise<{ fileContent: Buffer | undefined }>;
  deleteFile(options: { fileList: string[] }): Promise<{ fileList: unknown[] }>;
}

/**
 * CloudBase server-side `deleteFile` caps at 50 fileIDs per call. That is a
 * server-side limit, NOT enforced by the SDK type (design §23 C3), so batch
 * deletes must chunk themselves.
 */
const DELETE_CHUNK = 50;

const DEFAULT_TEMP_URL_MAX_AGE_SECONDS = 3600;

export function createCloudBaseMediaStorage(sdk: CloudBaseStorageSdk): MediaStorageAdapter {
  return {
    async putObject(input: PutMediaObjectInput): Promise<StoredMediaObject> {
      const storagePath = objectStoragePath(input);
      const { fileID } = await sdk.uploadFile({
        cloudPath: storagePath,
        fileContent: input.content,
      });
      return {
        storageProvider: 'cloudbase-storage',
        storageMode: 'classic-nosql-storage',
        storageFileId: fileID,
        storagePath,
        // Buffer/Uint8Array carry a known length; a stream does not.
        ...(input.content instanceof Uint8Array ? { byteSize: input.content.byteLength } : {}),
      };
    },

    async getObjectAsBase64(fileId: string): Promise<{ body: string; byteSize?: number }> {
      const { fileContent } = await sdk.downloadFile({ fileID: fileId });
      if (!fileContent) {
        throw new Error(`media-storage(cloudbase): download returned no content for ${fileId}`);
      }
      return { body: fileContent.toString('base64'), byteSize: fileContent.byteLength };
    },

    async getTempUrl(
      fileId: string,
      maxAgeSeconds?: number,
    ): Promise<{ url: string; expiresAt?: string }> {
      const maxAge = maxAgeSeconds ?? DEFAULT_TEMP_URL_MAX_AGE_SECONDS;
      const res = await sdk.getTempFileURL({ fileList: [{ fileID: fileId, maxAge }] });
      const first = res.fileList[0];
      if (!first || !first.tempFileURL) {
        throw new Error(`media-storage(cloudbase): no temp URL returned for ${fileId}`);
      }
      return {
        url: first.tempFileURL,
        expiresAt: new Date(Date.now() + maxAge * 1000).toISOString(),
      };
    },

    async deleteObject(fileId: string): Promise<void> {
      await sdk.deleteFile({ fileList: [fileId] });
    },
  };
}

/**
 * Delete many objects, chunked under the 50-per-call server cap (design §23 C3).
 * For migration/orphan cleanup (MIU-06), which the single-object `deleteObject`
 * on the adapter is not meant to handle in bulk.
 */
export async function deleteCloudBaseObjects(
  sdk: CloudBaseStorageSdk,
  fileIds: string[],
): Promise<void> {
  for (let i = 0; i < fileIds.length; i += DELETE_CHUNK) {
    await sdk.deleteFile({ fileList: fileIds.slice(i, i + DELETE_CHUNK) });
  }
}
