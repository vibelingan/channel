/**
 * CloudBase `MediaStorageAdapter` — the production backend.
 *
 * It deliberately does NOT import or initialise CloudBase SDKs itself. Instead
 * the caller passes the already-initialised server SDK in. This package then
 * stays browser-safe unless a cloud function explicitly imports the `./cloudbase`
 * entry (design §20.4 exit criterion).
 *
 * Storage signatures are verified against the installed @cloudbase/node-sdk@3.17.2.
 * `wx-server-sdk@4.0.2` does not expose `getUploadMetadata`, so upload credential
 * minting uses node-sdk directly via dependency injection.
 */
import { ReadStream } from 'node:fs';
import { type CloudBaseReadTransport, readCloudBaseBytes } from './cloudbase-get.ts';
import { type CloudBasePutOptions, checkedUploadUrl, putCloudBaseBytes } from './cloudbase-put.ts';
import {
  type MediaObjectReadOptions,
  type MediaStorageAdapter,
  type PutMediaObjectInput,
  type PutMediaObjectOptions,
  type StoredMediaObject,
  type UploadCredential,
  objectStoragePath,
} from './index.ts';
import {
  assertBrowserWritableMediaPath,
  assertProtectedMediaCheckpoint,
} from './protected-path.ts';

/** The injected node-sdk 3.17.2 storage surface; wx-server-sdk lacks the minter. */
export interface CloudBaseStorageSdk {
  uploadFile(options: {
    cloudPath: string;
    fileContent: Buffer | ReadStream;
  }): Promise<{ fileID: string }>;
  getTempFileURL(options: {
    fileList: (string | { fileID: string; maxAge?: number; urlType?: 'COS_URL' })[];
  }): Promise<{ fileList: { fileID: string; tempFileURL: string; code?: string }[] }>;
  // The installed type permits missing or string content. Byte integrity
  // requires a Buffer; the adapter checks it rather than treating text as bytes.
  downloadFile(options: {
    fileID: string;
  }): Promise<{ fileContent: Buffer | string | undefined }>;
  deleteFile(options: { fileList: string[] }): Promise<{ fileList: unknown[] }>;
  // Mints raw PUT header credentials; verify:cloudbase-sdk pins the sender body.
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

export function createCloudBaseMediaStorage(
  sdk: CloudBaseStorageSdk,
  transport: CloudBasePutOptions & CloudBaseReadTransport = {},
): MediaStorageAdapter {
  async function mintUploadCredential(cloudPath: string): Promise<UploadCredential> {
    const meta = await sdk.getUploadMetadata({ cloudPath });
    const data = meta?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(
        `media-storage(cloudbase): incomplete upload metadata (missing data) for ${cloudPath}`,
      );
    }
    const fields = data as Record<string, unknown>;
    // Every field is either a browser request header or the durable id the
    // image doc depends on. Treat the SDK response as untrusted at runtime so
    // a contract mismatch fails during mint instead of returning a
    // half-credential.
    const uploadUrl = requireStringField(fields, 'url', cloudPath);
    const authorization = requireStringField(fields, 'authorization', cloudPath);
    const token = requireStringField(fields, 'token', cloudPath);
    const cosFileId = requireStringField(fields, 'cosFileId', cloudPath);
    const storageFileId = requireStringField(fields, 'fileId', cloudPath);
    // Mirror the installed SDK's own `uploadFile` exactly: a raw PUT whose
    // headers carry the credential (Signature + the lowercase `authorization`
    // duplicate + the URI-encoded key). node-sdk 3.x requests the signature
    // for `method: 'put'`, so a multipart POST is rejected 403
    // SignatureDoesNotMatch.
    return {
      uploadUrl,
      method: 'PUT',
      headers: {
        Signature: authorization,
        'x-cos-security-token': token,
        'x-cos-meta-fileid': cosFileId,
        authorization,
        key: encodeURIComponent(cloudPath),
      },
      storageFileId,
    };
  }

  const storage: MediaStorageAdapter = {
    async putObject(
      input: PutMediaObjectInput,
      options: PutMediaObjectOptions = {},
    ): Promise<StoredMediaObject> {
      assertProtectedMediaCheckpoint(input.namespace, options.beforeWrite);
      const storagePath = objectStoragePath(input);
      const knownSize =
        input.content instanceof Uint8Array ? { byteSize: input.content.byteLength } : {};
      // Native uploadFile cannot checkpoint its internally minted target.
      // Generic streams also require this path: the installed SDK only accepts
      // Buffer or fs.ReadStream, despite the broader facade stream contract.
      if (
        options.beforeWrite ||
        !(input.content instanceof Uint8Array || input.content instanceof ReadStream)
      ) {
        const credential = await mintUploadCredential(storagePath);
        checkedUploadUrl(credential.uploadUrl);
        const target: StoredMediaObject = {
          storageProvider: 'cloudbase-storage',
          storageMode: 'classic-nosql-storage',
          storageFileId: credential.storageFileId,
          storagePath,
          ...knownSize,
        };
        await options.beforeWrite?.({ ...target });
        await putCloudBaseBytes(credential, input.content, transport);
        return target;
      }
      const content =
        input.content instanceof Uint8Array && !Buffer.isBuffer(input.content)
          ? Buffer.from(input.content)
          : input.content;
      const { fileID } = await sdk.uploadFile({ cloudPath: storagePath, fileContent: content });
      if (typeof fileID !== 'string' || fileID.length === 0)
        throw new Error('media-storage(cloudbase): upload returned no permanent file ID');
      return {
        storageProvider: 'cloudbase-storage',
        storageMode: 'classic-nosql-storage',
        storageFileId: fileID,
        storagePath,
        ...knownSize,
      };
    },

    async getObjectAsBase64(
      fileId: string,
      options?: MediaObjectReadOptions,
    ): Promise<{ body: string; byteSize?: number }> {
      if (options) {
        const bytes = await readCloudBaseBytes(sdk, fileId, options, transport);
        return { body: bytes.toString('base64'), byteSize: bytes.byteLength };
      }
      const { fileContent } = await sdk.downloadFile({ fileID: fileId });
      if (!fileContent) {
        throw new Error(`media-storage(cloudbase): download returned no content for ${fileId}`);
      }
      if (!Buffer.isBuffer(fileContent)) {
        // Text is not byte evidence, even when the SDK type allows it.
        throw new Error(
          `media-storage(cloudbase): download returned non-buffer content for ${fileId}`,
        );
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
      assertBrowserWritableMediaPath(cloudPath);
      return mintUploadCredential(cloudPath);
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
  return storage;
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
