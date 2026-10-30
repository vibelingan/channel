import { readCloudBaseBytes } from '../../packages/media-storage/src/cloudbase-get.ts';
import {
  checkedUploadUrl,
  putCloudBaseBytes,
} from '../../packages/media-storage/src/cloudbase-put.ts';
import { mintCloudBaseUploadCredential } from '../../packages/media-storage/src/cloudbase.ts';
import { sha256 } from './input.mjs';
const limit = 128 * 1024 * 1024;

/** Immutable content keys make a repeated or late archive PUT harmless; business objects are outside this prefix. */
export function createPrivateArchive({
  sdk,
  manager,
  policy,
  readLifecycle,
  put = putCloudBaseBytes,
  read = readCloudBaseBytes,
}) {
  const target = async (ref) => {
    if (
      !ref ||
      !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '') ||
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 1 ||
      ref.bytes > limit ||
      typeof ref.fileID !== 'string'
    )
      throw Error('Invalid private archive object');
    const prefix = `cloud://${policy.envId}.`;
    if (!ref.fileID.startsWith(prefix))
      throw Error('Archive object belongs to another environment');
    const rest = ref.fileID.slice(prefix.length);
    const slash = rest.indexOf('/');
    const bucket = rest.slice(0, slash);
    const path = rest.slice(slash + 1);
    if (
      slash < 1 ||
      !/^[-a-z0-9]+$/.test(bucket) ||
      path !== `seo-recovery/objects/${ref.sha256}.bin`
    )
      throw Error('Archive object escapes its content key');
    const result = await manager.permission.describeResourcePermission({
      resourceType: 'storage',
      resources: [bucket],
    });
    const entries = result.Data?.PermissionList;
    if (
      !Array.isArray(entries) ||
      entries.filter(
        (e) => e.Resource === bucket && e.ResourceType === 'storage' && e.Permission === 'PRIVATE',
      ).length !== 1
    )
      throw Error('Archive bucket must already be private; permissions were not changed');
    const lifecycle = await readLifecycle({ Bucket: bucket, Region: policy.region });
    assertArchiveLifecycle(lifecycle, path);
    return { bucket, path };
  };
  const get = async (ref) => {
    await target(ref);
    const bytes = await read(sdk, ref.fileID, { maxBytes: ref.bytes, timeoutMs: 60000 });
    if (!Buffer.isBuffer(bytes) || bytes.length !== ref.bytes || sha256(bytes) !== ref.sha256)
      throw Error('Private archive byte verification failed');
    return bytes;
  };
  return {
    get,
    async put(bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > limit)
        throw Error('Private archive size exceeds bound');
      const digest = sha256(bytes);
      const cloudPath = `seo-recovery/objects/${digest}.bin`;
      const credential = await mintCloudBaseUploadCredential(sdk, cloudPath);
      const ref = { fileID: credential.storageFileId, bytes: bytes.length, sha256: digest };
      const { bucket, path } = await target(ref);
      const url = checkedUploadUrl(credential.uploadUrl);
      if (
        url.hostname !== `${bucket}.cos.${policy.region}.myqcloud.com` ||
        decodeURIComponent(url.pathname) !== `/${path}`
      )
        throw Error('Archive upload target differs from its private object');
      try {
        await put(credential, bytes, { uploadTimeoutMs: 60000 });
      } catch {
        // Only a complete read of the exact immutable bytes can resolve a lost upload reply.
        try {
          await get(ref);
          return ref;
        } catch {
          throw Error('Private archive upload needs readback; website was not changed');
        }
      }
      await get(ref);
      return ref;
    },
  };
}

export function assertArchiveLifecycle(result, path) {
  if (!Array.isArray(result?.Rules)) throw Error('Archive lifecycle readback missing');
  for (const rule of result.Rules) {
    if (!['Enabled', 'Disabled'].includes(rule.Status))
      throw Error('Unknown archive lifecycle rule');
    if (rule.Status === 'Disabled') continue;
    const prefix = rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? '';
    if (typeof prefix !== 'string') throw Error('Unknown archive lifecycle prefix');
    if (!path.startsWith(prefix)) continue;
    if (rule.Expiration || JSON.stringify(rule.Transition ?? {}).match(/ARCHIVE|DEEP_ARCHIVE|COLD/))
      throw Error(
        'Archive path has an expiry or offline-storage rule; existing policy was not changed',
      );
  }
}
