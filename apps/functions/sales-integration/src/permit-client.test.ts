import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { issueTaskPermit } from '@vibelingan-channel/sales-contracts/task-access';
import { createPermitClient } from './permit-client.ts';

const f = JSON.parse(
  readFileSync(
    new URL('../../../../packages/sales-contracts/fixtures/task-access.json', import.meta.url),
    'utf8',
  ),
);
const token = 'c'.repeat(48);

test('fixed control client uses authenticated real HTTP and receives a bound request permit', async () => {
  let requests = 0;
  const server = createServer(async (request, reply) => {
    requests++;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/sales/authorize-read');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(value, f.request);
    reply.writeHead(200, { 'Content-Type': 'application/json' });
    reply.end(JSON.stringify(issueTaskPermit(value, f.authority, f.now)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = createPermitClient(
      `http://127.0.0.1:${address.port}/sales/authorize-read`,
      token,
      'test',
    );
    assert.deepEqual(await client(f.request), f.permit);
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('control redirects, invalid content, duplicate fields and oversized replies fail closed', async () => {
  for (const mode of ['redirect', 'html', 'duplicate', 'large', 'failure']) {
    const server = createServer((_request, reply) => {
      if (mode === 'redirect') {
        reply.writeHead(302, { Location: '/must-not-follow' });
        reply.end();
      } else if (mode === 'html') {
        reply.writeHead(200, { 'Content-Type': 'text/html' });
        reply.end('<h1>not a permit</h1>');
      } else if (mode === 'duplicate') {
        reply.writeHead(200, { 'Content-Type': 'application/json' });
        reply.end('{"allowed":true,"allowed":false}');
      } else if (mode === 'large') {
        reply.writeHead(200, { 'Content-Type': 'application/json' });
        reply.end('x'.repeat(16385));
      } else {
        reply.writeHead(503, { 'Content-Type': 'application/json' });
        reply.end('{"error":"private-key-must-not-escape"}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const client = createPermitClient(
        `http://127.0.0.1:${address.port}/sales/authorize-read`,
        token,
        'test',
      );
      await assert.rejects(() => client(f.request), {
        message: 'Sales control unavailable',
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test('control address is server-fixed, HTTPS-only in production and cannot carry credentials', () => {
  for (const address of [
    'http://control.invalid/sales/authorize-read',
    'http://127.0.0.1/sales/authorize-read',
    'https://user:pass@control.invalid/sales/authorize-read',
    'https://control.invalid/other',
    'https://control.invalid/sales/authorize-read?customer=other',
    'https://control.invalid/sales/authorize-read#other',
  ])
    assert.throws(() => createPermitClient(address, token, 'production'));
});

test('control request has a finite deadline even when the server never answers', async () => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = createPermitClient(
      `http://127.0.0.1:${address.port}/sales/authorize-read`,
      token,
      'test',
    );
    await assert.rejects(() => client(f.request), {
      message: 'Sales control unavailable',
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
