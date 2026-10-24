import { createServer } from 'node:http';
const actions = new Set(['me', 'articleDrafts', 'articleMedia', 'articleReleases', 'health']);
export function createBlogBridgeServer({ invoke, adminOrigin }) {
  const origin = new URL(adminOrigin);
  if (
    !['127.0.0.1', 'localhost'].includes(origin.hostname) ||
    origin.origin !== adminOrigin ||
    origin.protocol !== 'http:'
  )
    throw new Error('Exact loopback admin origin required');
  return createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    res.setHeader('vary', 'Origin');
    if (req.headers.origin && req.headers.origin !== adminOrigin) {
      res.writeHead(403);
      res.end('{}');
      return;
    }
    if (req.headers.origin === adminOrigin) {
      res.setHeader('access-control-allow-origin', adminOrigin);
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'Content-Type');
    }
    if (
      req.url !== '/api/admin' ||
      !['127.0.0.1', 'localhost'].includes((req.headers.host ?? '').split(':')[0])
    ) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    if (req.method === 'OPTIONS' && req.headers.origin === adminOrigin) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('{}');
      return;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 384 * 1024) throw new Error('Request too large');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!actions.has(input.action)) throw new Error('Only isolated article actions are accepted');
      const result = await invoke(input);
      const status = result.ok
        ? 200
        : result.error?.code === 'UNAUTHORIZED'
          ? 401
          : result.error?.code === 'FORBIDDEN'
            ? 403
            : result.error?.code === 'CONFLICT'
              ? 409
              : 400;
      res.writeHead(status);
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(502);
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: 'UNCONFIRMED', message: 'The real cloud request could not be confirmed.' },
        }),
      );
    }
  });
}
