/**
 * CloudBase `MediaStorageAdapter` — the production backend.
 *
 * It deliberately does NOT import or initialise CloudBase SDKs itself. Instead
 * the caller passes the already-initialised server SDK in. This package then
 * stays browser-safe unless a cloud function explicitly imports the `./cloudbase`
 * entry (design §20.4 exit criterion).
 *
 * Storage signatures are verified against the installed @cloudbase/node-sdk@2.10.0.
 * `wx-server-sdk@3.0.4` does not expose `getUploadMetadata`, so upload credential
 * minting uses node-sdk directly via dependency injection.
 */
import {
  type MediaStorageAdapter,
  type PutMediaObjectInput,
  type StoredMediaObject,
  type UploadCredential,
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
  // Mints a single-object direct COS form credential. The node-sdk returns
  // `{ data: { url, authorization, token, fileId, cosFileId } }` and its own
  // `uploadFile` implementation posts those fields as multipart/form-data.
  getUploadMetadata(options: { cloudPath: string }): Promise<{
    data?: {
      url?: unknown;
      authorization?: unknown;
      token?: unknown;
      fileId?: unknown;
      cosFileId?: unknown;
      download_url?: unknown;
    };
  }>;
}

/**
 * CloudBase server-side `deleteFile` caps at 50 fileIDs per call. That is a
 * server-side limit, NOT enforced by the SDK type (design §23 C3), so batch
 * deletes must chunk themselves.
 */
const DELETE_CHUNK = 50;

const DEFAULT_TEMP_URL_MAX_AGE_SECONDS = 3600;

function requireStringField(
  record: Record<string, unknown>,
  field: string,
  cloudPath: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `media-storage(cloudbase): incomplete upload metadata (missing ${field}) for ${cloudPath}`,
    );
  }
  return value;
}

/**
 * Inspect one entry of a CloudBase `deleteFile` per-file result. The shape
 * differs by SDK layer: `@cloudbase/node-sdk` returns `{ fileID, code }`
 * (success `code === 'SUCCESS'`), while the `wx-server-sdk` wrapper returns
 * `{ fileID, status, errMsg }` (success `status === 0`). So we inspect both
 * defensively and treat anything we cannot positively confirm as a success as a
 * failure — CloudBase rule STO-004: per-file delete results MUST be checked, or
 * a rejected object silently leaks (orphaned private bytes, no retry signal).
 */
function inspectDeleteEntry(entry: unknown): {
  fileID?: string | undefined;
  ok: boolean;
  reason?: string;
} {
  if (!entry || typeof entry !== 'object') {
    return { ok: false, reason: 'malformed delete-result entry' };
  }
  const e = entry as Record<string, unknown>;
  const fileID =
    typeof e.fileID === 'string' ? e.fileID : typeof e.fileId === 'string' ? e.fileId : undefined;
  if (e.status === 0 || e.code === 'SUCCESS' || e.code === 0) {
    return { fileID, ok: true };
  }
  const reason =
    (typeof e.errMsg === 'string' && e.errMsg) ||
    (typeof e.message === 'string' && e.message) ||
    (e.code != null ? `code=${String(e.code)}` : undefined) ||
    (e.status != null ? `status=${String(e.status)}` : undefined) ||
    'unconfirmed delete (no success marker)';
  return { fileID, ok: false, reason };
}

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

    async getUploadCredential(cloudPath: string): Promise<UploadCredential> {
      const meta = await sdk.getUploadMetadata({ cloudPath });
      const data = meta?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error(
          `media-storage(cloudbase): incomplete upload metadata (missing data) for ${cloudPath}`,
        );
      }
      const fields = data as Record<string, unknown>;
      // Every field is either a browser form field or the durable id the image
      // doc depends on. Treat the SDK response as untrusted at runtime so a
      // contract mismatch fails during mint instead of returning a half-credential.
      const uploadUrl = requireStringField(fields, 'url', cloudPath);
      const authorization = requireStringField(fields, 'authorization', cloudPath);
      const token = requireStringField(fields, 'token', cloudPath);
      const cosFileId = requireStringField(fields, 'cosFileId', cloudPath);
      const storageFileId = requireStringField(fields, 'fileId', cloudPath);
      return {
        uploadUrl,
        method: 'POST',
        formFields: {
          Signature: authorization,
          'x-cos-security-token': token,
          'x-cos-meta-fileid': cosFileId,
          key: cloudPath,
        },
        storageFileId,
      };
    },

    async deleteObject(fileId: string): Promise<void> {
      const res = await sdk.deleteFile({ fileList: [fileId] });
      const entry = res.fileList[0];
      const outcome =
        entry === undefined
          ? { ok: false, reason: 'no delete result returned' }
          : inspectDeleteEntry(entry);
      if (!outcome.ok) {
        throw new Error(
          `media-storage(cloudbase): delete failed for ${fileId}: ${outcome.reason ?? 'unknown'}`,
        );
      }
      if (outcome.fileID !== fileId) {
        throw new Error(
          `media-storage(cloudbase): delete result mismatch for ${fileId}: returned ${
            outcome.fileID ?? 'no fileID'
          }`,
        );
      }
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
  if (fileIds.length === 0) return;
  const succeeded = new Set<string>();
  const failed = new Map<string, string>(); // fileID -> reason
  let unattributableFailures = 0;
  for (let i = 0; i < fileIds.length; i += DELETE_CHUNK) {
    const res = await sdk.deleteFile({ fileList: fileIds.slice(i, i + DELETE_CHUNK) });
    for (const entry of res.fileList) {
      const outcome = inspectDeleteEntry(entry);
      if (outcome.ok) {
        if (outcome.fileID) succeeded.add(outcome.fileID);
      } else if (outcome.fileID) {
        failed.set(outcome.fileID, outcome.reason ?? 'failed');
      } else {
        unattributableFailures += 1;
      }
    }
  }
  // A requested id with neither a success nor an explicit failure entry was
  // silently dropped by the SDK — treat as a failure so cleanup callers retry.
  const missing = fileIds.filter((id) => !succeeded.has(id) && !failed.has(id));
  if (failed.size > 0 || missing.length > 0 || unattributableFailures > 0) {
    const parts = [
      ...[...failed].map(([id, reason]) => `${id} (${reason})`),
      ...missing.map((id) => `${id} (no delete result)`),
      ...(unattributableFailures > 0
        ? [`${unattributableFailures} unattributable failure(s)`]
        : []),
    ];
    throw new Error(`media-storage(cloudbase): delete failed for: ${parts.join(', ')}`);
  }
}
