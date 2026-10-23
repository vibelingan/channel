import type { MediaStorageAdapter } from '@vibelingan-channel/media-storage';
import { OEM_FILE_MAX_BYTES } from '@vibelingan-channel/shared/media';

export async function readPrivateFile(
  storage: Pick<MediaStorageAdapter, 'getTempUrl'>,
  id: string,
  hosts: readonly string[],
  request = fetch,
): Promise<{ body: string; byteSize: number }> {
  const signed = await storage.getTempUrl(id, 30);
  const url = new URL(signed.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !hosts.includes(url.hostname)
  )
    throw new Error('Private file unavailable');
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const length = response.headers.get('content-length');
  if (
    !response.ok ||
    !response.body ||
    (length && (!/^\d+$/.test(length) || Number(length) > OEM_FILE_MAX_BYTES))
  ) {
    await response.body?.cancel();
    throw new Error('Private file unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > OEM_FILE_MAX_BYTES) throw new Error('Private file exceeds limit');
      chunks.push(Buffer.from(part.value));
    }
    return { body: Buffer.concat(chunks).toString('base64'), byteSize: size };
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
