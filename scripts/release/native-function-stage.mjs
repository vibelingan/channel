import { randomBytes } from 'node:crypto';
import { mintCloudBaseUploadCredential } from '../../packages/media-storage/src/cloudbase.ts';
import { createCosArchiveTransfer } from './cos-archive-transfer.mjs';
import { sha256 } from './input.mjs';

/** Preserve the exact recovery ZIP, then copy it server-side to the official deployment staging path. */
export function createNativeFunctionStage({
  manager,
  sdk,
  cos,
  policy,
  objects,
  now = Date.now,
  nonce = () => randomBytes(8).toString('hex'),
  timeoutMs = 60000,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw Error('A bounded native staging deadline is required');
  return async (bytes) => {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 15 * 1024 * 1024)
      throw Error('Native function ZIP exceeds its reviewed bound');
    const seconds = Math.floor(now() / 1000);
    const suffix = nonce();
    if (!/^\d{10}$/.test(String(seconds)) || !/^[a-f0-9]{16}$/.test(suffix))
      throw Error('Invalid native function staging identity');
    const key = `fnzip-upload/${seconds}-${suffix}/alibaba-catalog-sync.zip`;
    try {
      const environment = manager.currentEnvironment();
      await environment.lazyInit();
      const config = environment.lazyEnvironmentConfig;
      if (
        environment.getEnvId() !== policy.envId ||
        manager.getManagerConfig().envId !== policy.envId ||
        manager.getManagerConfig().region !== policy.region ||
        config?.EnvId !== policy.envId ||
        config.Storages?.[0]?.Bucket !== policy.archiveBucket ||
        config.Storages[0].Region !== policy.region
      )
        throw Error('Native staging storage differs from the bound environment');

      const privateRule = async () => {
        const permission = await manager.permission.describeResourcePermission({
          resourceType: 'storage',
          resources: [policy.archiveBucket],
        });
        if (
          permission.Data?.PermissionList?.filter(
            (entry) =>
              entry.Resource === policy.archiveBucket &&
              entry.ResourceType === 'storage' &&
              entry.Permission === 'PRIVATE',
          ).length !== 1
        )
          throw Error('Native staging bucket is not confirmed private');
      };
      await privateRule();

      const digest = sha256(bytes);
      const sourceKey = `seo-recovery/objects/${digest}.bin`;
      const prefix = `cloud://${policy.envId}.${policy.archiveBucket}/`;
      const original = await objects.put(bytes);
      if (
        original?.fileID !== `${prefix}${sourceKey}` ||
        original.bytes !== bytes.length ||
        original.sha256 !== digest
      )
        throw Error('Native recovery ZIP differs before staging');
      const credential = await mintCloudBaseUploadCredential(sdk, key);
      const url = new URL(credential.uploadUrl);
      if (
        credential.storageFileId !== `${prefix}${key}` ||
        url.origin !== `https://${policy.archiveBucket}.cos.${policy.region}.myqcloud.com` ||
        url.pathname !== `/${key}` ||
        url.username ||
        url.password ||
        url.hash ||
        !credential.headers?.['x-cos-meta-fileid']
      )
        throw Error('Native staging metadata points outside its exact object');

      const params = { Bucket: policy.archiveBucket, Region: policy.region };
      const source = await cos.headObject({ ...params, Key: sourceKey });
      if (
        Number(source?.headers?.['content-length']) !== bytes.length ||
        typeof source.ETag !== 'string' ||
        !source.ETag
      )
        throw Error('Native staging source changed');
      await copyOnce(
        cos,
        {
          ...params,
          Key: key,
          CopySource: `${params.Bucket}.cos.${params.Region}.myqcloud.com/${sourceKey}`,
          CopySourceIfMatch: source.ETag,
          MetadataDirective: 'Replaced',
          Headers: { 'x-cos-meta-fileid': credential.headers['x-cos-meta-fileid'] },
          ContentType: 'application/zip',
          CacheControl: 'private, no-store',
        },
        timeoutMs,
      );
      const transfer = createCosArchiveTransfer({ cos, policy, nativeCodeKey: key });
      const actual = await transfer.read(sdk, `${prefix}${key}`, {
        maxBytes: bytes.length,
        timeoutMs,
      });
      if (sha256(actual) !== digest) throw Error('Native staging ZIP hash differs');
      // Recheck the existing private rule; neither this operation nor the copy sets an ACL.
      await privateRule();
      return { fileID: `${prefix}${key}`, bytes: bytes.length, sha256: digest };
    } catch (error) {
      // Unknown copies stay in their unique private path; never retry, delete, or submit code here.
      throw Object.assign(
        Error('Native function staging unconfirmed; no function code submitted'),
        {
          code: error?.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'NATIVE_CODE_STAGING_UNCONFIRMED',
        },
      );
    }
  };
}

function copyOnce(cos, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          Object.assign(Error('Copy timed out'), {
            code: 'ETIMEDOUT',
          }),
        ),
      timeoutMs,
    );
    try {
      cos.putObjectCopy(params, finish);
    } catch (error) {
      finish(error);
    }
  });
}
