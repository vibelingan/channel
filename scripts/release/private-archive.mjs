import { checkedUploadUrl } from '../../packages/media-storage/src/cloudbase-put.ts';
import { mintCloudBaseUploadCredential } from '../../packages/media-storage/src/cloudbase.ts';
import { sha256 } from './input.mjs';
const limit = 128 * 1024 * 1024;

/** Immutable content keys make a repeated or late archive PUT harmless; business objects are outside this prefix. */
export function createPrivateArchive({
  sdk,
  manager,
  policy,
  readLifecycle,
  put,
  read,
  head = null,
  onTransfer = (_event) => {},
  now = () => performance.now(),
  policyCacheMs = 0,
  slowLinkBytesPerSecond = 0,
}) {
  if (typeof put !== 'function' || typeof read !== 'function')
    throw Error('An explicit verified archive transport is required');
  if (!/^[-a-z0-9]+$/.test(policy.archiveBucket ?? ''))
    throw Error('The exact private archive bucket is required');
  if (!Number.isSafeInteger(policyCacheMs) || policyCacheMs < 0 || policyCacheMs > 15 * 60000)
    throw Error('Archive policy cache window must be at most 15 minutes');
  if (
    !Number.isSafeInteger(slowLinkBytesPerSecond) ||
    (slowLinkBytesPerSecond !== 0 && slowLinkBytesPerSecond < 1024)
  )
    throw Error('Archive slow-link rate must be 0 or at least 1 KiB/s');
  // Opt-in: a caller moving many objects in one process re-checks the bucket's privacy
  // and lifecycle once per window instead of twice per object. A failed check is never kept.
  let checkedPolicy = null;
  const bucketPolicy = (bucket) => {
    const at = now();
    if (checkedPolicy && checkedPolicy.bucket === bucket && at - checkedPolicy.at < policyCacheMs)
      return checkedPolicy.lifecycle;
    const lifecycle = (async () => {
      const result = await manager.permission.describeResourcePermission({
        resourceType: 'storage',
        resources: [bucket],
      });
      const entries = result.Data?.PermissionList;
      if (
        !Array.isArray(entries) ||
        entries.filter(
          (e) =>
            e.Resource === bucket && e.ResourceType === 'storage' && e.Permission === 'PRIVATE',
        ).length !== 1
      )
        throw Error('Archive bucket must already be private; permissions were not changed');
      return readLifecycle({ Bucket: bucket, Region: policy.region });
    })();
    if (policyCacheMs > 0) {
      const entry = { bucket, at, lifecycle };
      checkedPolicy = entry;
      lifecycle.catch(() => {
        if (checkedPolicy === entry) checkedPolicy = null;
      });
    }
    return lifecycle;
  };
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
    if (bucket !== policy.archiveBucket)
      throw Error('Wrong archive bucket; no other resource was queried');
    assertArchiveLifecycle(await bucketPolicy(bucket), path);
    return { bucket, path };
  };
  // Opt-in: a deadline that grows with the object, so a slow but moving link (one connection
  // from the US has carried ~8 KB/s) is not cut off at a fixed 60 s; capped at 15 minutes.
  const timeout = (bytes) => {
    const fixed = bytes > 8 * 1024 * 1024 ? 300000 : 60000;
    if (!slowLinkBytesPerSecond) return fixed;
    const sized = 60000 + Math.ceil((bytes / slowLinkBytesPerSecond) * 1000);
    return Math.min(15 * 60000, Math.max(fixed, sized));
  };
  const observe = async (action, ref, operation) => {
    const started = Date.now();
    try {
      const value = await operation();
      onTransfer({
        action,
        bytes: ref.bytes,
        sha256: ref.sha256,
        elapsedMs: Date.now() - started,
        outcome: 'complete',
      });
      return value;
    } catch (error) {
      onTransfer({
        action,
        bytes: ref.bytes,
        sha256: ref.sha256,
        elapsedMs: Date.now() - started,
        outcome: 'unconfirmed',
        cause: safeArchiveError(error),
      });
      throw error;
    }
  };
  const remaining = (deadline) => {
    const value = Math.floor(deadline - now());
    if (value < 1)
      throw Object.assign(Error('Archive continuation budget exhausted'), { code: 'ETIMEDOUT' });
    return value;
  };
  const withinDeadline = async (deadline, operation) => {
    if (deadline === Number.POSITIVE_INFINITY) return operation();
    const milliseconds = remaining(deadline);
    let timer;
    try {
      const value = await Promise.race([
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(Error('Archive continuation budget exhausted'), {
                  code: 'ETIMEDOUT',
                }),
              ),
            milliseconds,
          );
        }),
        Promise.resolve().then(operation),
      ]);
      remaining(deadline);
      return value;
    } finally {
      clearTimeout(timer);
    }
  };
  const get = async (ref, deadline = Number.POSITIVE_INFINITY) => {
    const readDeadline = Math.min(deadline, now() + timeout(ref?.bytes));
    for (let attempt = 0; attempt < 2; attempt++) {
      // Policy failures are terminal; only the complete byte read may be retried.
      await withinDeadline(readDeadline, () => target(ref));
      try {
        return await observe('read', ref, async () => {
          const bytes = await withinDeadline(readDeadline, () =>
            read(sdk, ref.fileID, {
              maxBytes: ref.bytes,
              timeoutMs: remaining(readDeadline),
            }),
          );
          if (!Buffer.isBuffer(bytes) || bytes.length !== ref.bytes || sha256(bytes) !== ref.sha256)
            throw Error('Private archive byte verification failed');
          return bytes;
        });
      } catch (error) {
        if (attempt === 1 || !transientArchiveError(error)) throw error;
        remaining(readDeadline);
      }
    }
    throw Error('Private archive read attempts exhausted');
  };
  return {
    get,
    /** Size and version of a stored object without its bytes; absent → ARCHIVE_OBJECT_NOT_FOUND. */
    async stat(ref) {
      if (typeof head !== 'function') throw Error('Archive object version check unavailable');
      await target(ref);
      const value = await observe('stat', ref, () => head(sdk, ref.fileID));
      if (
        !Number.isSafeInteger(value?.bytes) ||
        value.bytes < 0 ||
        typeof value.etag !== 'string' ||
        !value.etag
      )
        throw Error('Archive object version is incomplete');
      return { bytes: value.bytes, etag: value.etag };
    },
    async put(input) {
      if (!Buffer.isBuffer(input) || input.length < 1 || input.length > limit)
        throw Error('Private archive size exceeds bound');
      // Own the bytes before any await: a caller changing its Buffer cannot alter
      // a later continuation or write different content under this digest.
      const bytes = Buffer.from(input);
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
        await observe('put', ref, () =>
          put(credential, bytes, { uploadTimeoutMs: timeout(bytes.length) }),
        );
      } catch (uploadError) {
        // One bounded window covers readback, renewed policy checks and the resumed
        // upload, with the last minute reserved for verifying a lost upload reply.
        // The transport creates a new local path on each call,
        // forcing COS 2.15.4 to check remote part MD5/size instead of its path cache.
        const deadline = now() + timeout(bytes.length);
        const uploadDeadline = deadline - 60000;
        // Only a complete read of the exact immutable bytes can resolve a lost upload reply.
        try {
          await get(ref, deadline);
          return ref;
        } catch (readError) {
          if (
            bytes.length <= 8 * 1024 * 1024 ||
            !transientArchiveError(uploadError) ||
            readError?.code !== 'ARCHIVE_OBJECT_NOT_FOUND'
          )
            throw Error('Private archive upload needs readback; website was not changed');
        }
        try {
          await withinDeadline(deadline, () => target(ref));
          if (sha256(bytes) !== digest)
            throw Error('Private archive bytes changed before continuation');
          const uploadTimeoutMs = remaining(uploadDeadline);
          await observe('resume', ref, () =>
            withinDeadline(uploadDeadline, () => put(credential, bytes, { uploadTimeoutMs })),
          );
        } catch {
          // A timeout or lost reply is resolved only by reading the exact object.
        }
        try {
          await get(ref, deadline);
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

function transientArchiveError(error) {
  // A successful response header does not prove its body arrived: request 2.88.2
  // can still report ESOCKETTIMEDOUT with statusCode 200. Redirects and client
  // errors remain terminal, even when accompanied by a network code.
  if (Number.isSafeInteger(error?.statusCode) && error.statusCode >= 300)
    return error.statusCode >= 500 && error.statusCode <= 599;
  return [
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'ECONNRESET',
    'EPIPE',
    'ENOTFOUND',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ].includes(error?.code);
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

// SDK errors may contain signed URLs; retain only known categories, never the raw message.
function safeArchiveError(error) {
  if (['timeout', 'unavailable', 'too-large'].includes(error?.reason)) return error.reason;
  if (/upload timed out$/.test(error?.message ?? '')) return 'timeout';
  if (Number.isSafeInteger(error?.statusCode) && error.statusCode >= 300 && error.statusCode <= 599)
    return `http-${error.statusCode}`;
  const status = /unconfirmed upload \(HTTP ([1-5][0-9]{2})\)/.exec(error?.message ?? '')?.[1];
  if (status) return `http-${status}`;
  if (
    [
      'ETIMEDOUT',
      'ESOCKETTIMEDOUT',
      'ECONNRESET',
      'EPIPE',
      'ENOTFOUND',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'CERT_HAS_EXPIRED',
      'ARCHIVE_SOURCE_MISMATCH',
      'ARCHIVE_PROGRESS_INVALID',
      'ARCHIVE_SOURCE_CHANGED',
      'ARCHIVE_LOCAL_SIZE_MISMATCH',
      'ARCHIVE_OBJECT_NOT_FOUND',
    ].includes(error?.code)
  )
    return error.code;
  if (Number.isSafeInteger(error?.statusCode) && error.statusCode >= 100 && error.statusCode < 300)
    return `http-${error.statusCode}`;
  return 'unconfirmed';
}
