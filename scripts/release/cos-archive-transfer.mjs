import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Official SDK multipart/range transfers; the caller still checks private ACL, lifecycle and full SHA-256. */
export function createCosArchiveTransfer({ cos, policy }) {
  if (!policy.archiveBucket || !policy.archiveBucket.includes(policy.envId))
    throw Error('The archive storage bucket must be bound to this environment');
  const target = (fileId) => {
    const prefix = `cloud://${policy.envId}.${policy.archiveBucket}/`;
    if (typeof fileId !== 'string' || !fileId.startsWith(prefix))
      throw Error('Archive transfer belongs to another bucket or environment');
    const Key = fileId.slice(prefix.length);
    if (!/^seo-recovery\/objects\/[a-f0-9]{64}\.bin$/.test(Key))
      throw Error('Archive transfer escapes its owned content path');
    return { Bucket: policy.archiveBucket, Region: policy.region, Key };
  };
  return {
    async put(credential, bytes, { uploadTimeoutMs = 60000 } = {}) {
      const params = target(credential.storageFileId);
      const url = new URL(credential.uploadUrl);
      if (
        url.origin !== `https://${params.Bucket}.cos.${params.Region}.myqcloud.com` ||
        decodeURIComponent(url.pathname) !== `/${params.Key}` ||
        url.username ||
        url.password
      )
        throw Error('COS archive upload target differs');
      const fileId = credential.headers?.['x-cos-meta-fileid'];
      if (typeof fileId !== 'string' || !fileId) throw Error('CloudBase archive metadata missing');
      const directory = await mkdtemp(join(tmpdir(), 'catalog-archive-upload-'));
      const FilePath = join(directory, 'object.bin');
      try {
        await writeFile(FilePath, bytes, { mode: 0o600, flag: 'wx' });
        let task;
        let canceled = false;
        await boundedTransfer(
          uploadTimeoutMs,
          (done) => {
            cos.uploadFile(
              {
                ...params,
                FilePath,
                SliceSize: 1024 * 1024,
                ChunkSize: 1024 * 1024,
                Headers: { 'x-cos-meta-fileid': fileId },
                ContentType: 'application/octet-stream',
                CacheControl: 'private, no-store',
                onTaskReady(id) {
                  task = id;
                  if (canceled) cos.cancelTask(id);
                },
              },
              done,
            );
          },
          () => {
            canceled = true;
            if (task) cos.cancelTask(task);
          },
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async read(_sdk, fileId, { maxBytes, timeoutMs }) {
      const params = target(fileId);
      const directory = await mkdtemp(join(tmpdir(), 'catalog-archive-download-'));
      const FilePath = join(directory, 'object.bin');
      const task = randomUUID();
      let canceled = false;
      const stop = () => {
        canceled = true;
        cos.emit('inner-kill-task', { TaskId: task });
      };
      const active = () => {
        if (canceled)
          throw Object.assign(Error('Archive download canceled'), { code: 'ETIMEDOUT' });
      };
      try {
        const result = await boundedTransfer(
          timeoutMs,
          (done) => {
            const run = async () => {
              // The single deadline covers both metadata checks and every body range.
              const before = await cos.headObject(params);
              active();
              const length = Number(before?.headers?.['content-length']);
              if (
                length !== maxBytes ||
                !Number.isSafeInteger(length) ||
                length < 1 ||
                length > 128 * 1024 * 1024 ||
                typeof before.ETag !== 'string'
              )
                throw Error('Archive source length or version differs');
              await new Promise((resolve, reject) =>
                cos.downloadFile(
                  {
                    ...params,
                    FilePath,
                    TaskId: task,
                    ChunkSize: 1024 * 1024,
                    ParallelLimit: 3,
                    RetryTimes: 1,
                    onProgress(progress) {
                      if (progress.total !== maxBytes || progress.loaded > maxBytes) {
                        stop();
                        reject(Error('Archive download exceeds expected bytes'));
                      }
                    },
                  },
                  (error, value) => (error ? reject(error) : resolve(value)),
                ),
              );
              active();
              const after = await cos.headObject(params);
              active();
              if (
                after?.ETag !== before.ETag ||
                Number(after?.headers?.['content-length']) !== maxBytes ||
                (await stat(FilePath)).size !== maxBytes
              )
                throw Error('Archive object changed during download');
              return await readFile(FilePath);
            };
            run().then(
              (value) => done(null, value),
              (error) => done(error),
            );
          },
          stop,
        );
        if (!Buffer.isBuffer(result)) throw Error('Archive transfer did not return bytes');
        return result;
      } finally {
        stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

/** A timed-out SDK task is canceled, not silently retried by this caller. Late results cannot extend its budget. */
function boundedTransfer(timeoutMs, start, cancel = () => {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw Error('Invalid archive transfer time limit');
  return new Promise((resolve, reject) => {
    let finished = false;
    const complete = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        const wrapped = new Error('Archive COS transfer unconfirmed');
        if (
          typeof error.code === 'string' &&
          [
            'ETIMEDOUT',
            'ECONNRESET',
            'EPIPE',
            'ENOTFOUND',
            'ECONNREFUSED',
            'EHOSTUNREACH',
            'ENETUNREACH',
          ].includes(error.code)
        )
          wrapped.code = error.code;
        if (Number.isSafeInteger(error.statusCode)) wrapped.statusCode = error.statusCode;
        reject(wrapped);
      } else resolve(value);
    };
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        cancel();
      } catch {}
      reject(Object.assign(new Error('Archive COS transfer timed out'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    try {
      start(complete);
    } catch (error) {
      complete(error);
    }
  });
}
