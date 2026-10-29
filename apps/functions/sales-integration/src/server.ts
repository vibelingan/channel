import { createServer } from 'node:http';
import type { SalesRequest, SalesResponse } from './handler.ts';
import { salesBodyLimit } from './source-grant-route.ts';

export function createSalesServer(handle: (request: SalesRequest) => Promise<SalesResponse>) {
  return createServer({ headersTimeout: 10000, requestTimeout: 15000 }, async (request, reply) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let replied = false;
    const bodyLimit = salesBodyLimit(request.url ?? '/');
    const send = (result: SalesResponse) => {
      if (replied || reply.destroyed) return;
      replied = true;
      reply.writeHead(result.status, {
        ...result.headers,
        'Content-Length': String(result.body.byteLength),
      });
      reply.end(result.body);
    };
    const tooLarge = () =>
      send({
        status: 413,
        headers: { 'Cache-Control': 'private, no-store' },
        body: Buffer.from('{"code":"BODY_TOO_LARGE"}'),
      });
    if (Number(request.headers['content-length'] ?? 0) > bodyLimit) {
      request.resume();
      tooLarge();
      return;
    }
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > bodyLimit) {
        chunks.length = 0;
        tooLarge();
      } else if (!replied) chunks.push(chunk);
    });
    request.on('end', async () => {
      if (replied) return;
      const headers: SalesRequest['headers'] = {};
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i]?.toLowerCase();
        const value = request.rawHeaders[i + 1];
        if (!name || value === undefined) continue;
        const prior = headers[name];
        headers[name] =
          prior === undefined ? value : [...(Array.isArray(prior) ? prior : [prior]), value];
      }
      try {
        send(
          await handle({
            method: request.method ?? 'GET',
            url: request.url ?? '/',
            headers,
            body: Buffer.concat(chunks),
          }),
        );
      } catch {
        send({
          status: 503,
          headers: { 'Cache-Control': 'private, no-store' },
          body: Buffer.from('{"code":"SERVICE_UNAVAILABLE"}'),
        });
      }
    });
    request.on('error', () => {
      if (!reply.destroyed) reply.destroy();
    });
  });
}
