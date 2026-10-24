import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inventoryIdentity } from './hosting-recovery.mjs';
import { backupObjectPath } from './release/input.mjs';
import { fetchFully } from './smoke-http.mjs';

/** Bounded reads replace the SDK's unhandled stream piping. Never seal partial bytes. */
export async function downloadHostingBackupFiles({
  origin,
  directory,
  entries,
  request = fetchFully,
  storageLayout = 'paths',
}) {
  if (!['paths', 'sha256-path-v1'].includes(storageLayout))
    throw new Error('Unknown backup layout.');
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
  )
    throw new Error('Backup requires an HTTPS origin (HTTP loopback is test-only).');
  const files = inventoryIdentity(entries);
  const controller = new AbortController();
  const contentProofs = [];
  let cursor = 0;
  let failure;
  async function download([path, bytes, etag]) {
    const address = `${origin}/${path.split('/').map(encodeURIComponent).join('/')}`;
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await request('GET', address, {
          maxBytes: bytes + 1,
          timeoutMs: 60_000,
          signal: controller.signal,
          redirect: 'error',
          headers: { 'cache-control': 'no-cache', 'accept-encoding': 'identity' },
        });
        if (response.status >= 500) throw new Error(`Backup HTTP ${response.status}: ${path}`);
        break;
      } catch (error) {
        if (attempt === 2 || controller.signal.aborted) throw error;
      }
    }
    if (![200, 404].includes(response.status))
      throw new Error(`Backup HTTP ${response.status}: ${path}`);
    if (response.body.length !== bytes) throw new Error(`Backup bytes differ: ${path}`);
    const md5 = etag.replaceAll('"', '');
    if (/^[a-f0-9]{32}$/i.test(md5)) {
      if (createHash('md5').update(response.body).digest('hex') !== md5.toLowerCase())
        throw new Error(`Backup digest differs: ${path}`);
    } else {
      if (response.headers.get('etag') !== etag) throw new Error(`Backup ETag differs: ${path}`);
      contentProofs.push({
        path,
        etag,
        bytes,
        sha256: createHash('sha256').update(response.body).digest('hex'),
      });
    }
    const localPath = resolve(
      directory,
      storageLayout === 'sha256-path-v1' ? backupObjectPath(path) : path,
    );
    if (existsSync(localPath)) throw new Error(`Backup file already exists: ${path}`);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, response.body, { flag: 'wx' });
  }
  await Promise.all(
    Array.from({ length: Math.min(3, files.length) }, async () => {
      while (!controller.signal.aborted) {
        const index = cursor++;
        if (index >= files.length) return;
        try {
          await download(files[index]);
        } catch (error) {
          failure ??= error;
          controller.abort(error);
          return;
        }
      }
    }),
  );
  if (failure) throw failure;
  return { files: files.length, contentProofs };
}
