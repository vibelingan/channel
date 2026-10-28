import { parseStrictJson } from '@vibelingan-channel/sales-contracts';
import type { TaskReadRequest } from '@vibelingan-channel/sales-contracts';

export function createPermitClient(
  endpoint: string,
  token: string,
  environment: 'test' | 'production',
) {
  const url = new URL(endpoint);
  const loopback =
    environment === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (
    (!loopback && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/sales/authorize-read' ||
    !/^[A-Za-z0-9_-]{32,512}$/.test(token)
  )
    throw new Error('Invalid fixed Sales control connection');
  return async (request: TaskReadRequest): Promise<unknown> => {
    try {
      const reply = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      if (
        reply.status !== 200 ||
        reply.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'application/json' ||
        !reply.body
      )
        throw new Error('Invalid permit response');
      const reader = reply.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 16384) throw new Error('Permit response too large');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return parseStrictJson(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new Error('Sales control unavailable');
    }
  };
}
