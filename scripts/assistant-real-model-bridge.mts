/** Local test-only bridge: real model credentials stay on the existing Hermes host. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { sshAccess } from './assistant-ssh-fetch.ts';
const token = process.env.ASSISTANT_MODEL_BRIDGE_TOKEN ?? '';
assert.match(token, /^[A-Za-z0-9_-]{48,128}$/);
const access = sshAccess(
  process.env.ASSISTANT_SSH_CONFIG ?? '',
  process.env.ASSISTANT_SSH_HOST ?? '',
);
const metadata = await access.install();
const server = createServer(async (req, res) => {
  try {
    if (
      req.method !== 'POST' ||
      req.url !== '/v1/chat/completions' ||
      req.headers.authorization !== `Bearer ${token}`
    ) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 131072) throw new Error('body too large');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    assert.ok(
      Number.isSafeInteger(body.max_completion_tokens) &&
        body.max_completion_tokens >= 128 &&
        body.max_completion_tokens <= 4096,
    );
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const response = await access.fetch('https://model.ssh.invalid/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
      body: JSON.stringify({
        model: metadata.model,
        messages: body.messages,
        max_tokens: body.max_completion_tokens,
        stream: false,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
      }),
    });
    res.writeHead(response.status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(await response.text());
  } catch {
    res
      .writeHead(503, { 'Content-Type': 'application/json' })
      .end('{"error":{"message":"Live model unavailable"}}');
  }
});
server.listen(62685, '127.0.0.1', () =>
  console.log(
    JSON.stringify({ type: 'ready', origin: 'http://127.0.0.1:62685/v1', model: metadata.model }),
  ),
);
for (const name of ['SIGINT', 'SIGTERM'] as const)
  process.once(name, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
