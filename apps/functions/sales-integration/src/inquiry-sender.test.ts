import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateContract, type InquirySubmitted } from '@vibelingan-channel/sales-contracts';
import { HttpInquirySender, sourcePayloadHash } from './inquiry-sender.ts';

const event = validateContract(
  'inquiry',
  JSON.parse(
    readFileSync(
      new URL('../../../../packages/sales-contracts/fixtures/inquiry.json', import.meta.url),
      'utf8',
    ),
  ),
);
const body = JSON.stringify({ task_id: 42, run_id: 'a'.repeat(32), state: 'queued' });
async function serverFixture(handler: (request: IncomingMessage, reply: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    endpoint: `http://127.0.0.1:${address.port}/sales/events`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
function headers(input: InquirySubmitted = event) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Sales-Receipt': 'source-v1',
    'X-Sales-Source-Sha256': sourcePayloadHash(input),
  };
}

test('fixed sender posts exact source and consumes a source-bound strict receipt', async () => {
  let received: unknown;
  const server = await serverFixture((request, reply) => {
    assert.equal(request.url, '/sales/events');
    assert.equal(request.headers['x-sales-receipt'], 'source-v1');
    assert.equal(request.headers.authorization, `Bearer ${'s'.repeat(48)}`);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString());
      reply.writeHead(202, headers());
      reply.end(body);
    });
  });
  try {
    const sender = new HttpInquirySender(server.endpoint, 's'.repeat(48), 'test');
    assert.deepEqual(await sender.send(event), {
      task_id: 42,
      run_id: 'a'.repeat(32),
      state: 'queued',
    });
    assert.deepEqual(received, event);
  } finally {
    await server.close();
  }
});

test('body receipt, wrong digest, duplicate header, MIME and status errors are rejected', async (t) => {
  const scenarios = [
    {
      name: 'wrong digest',
      code: 202,
      head: { ...headers(), 'X-Sales-Source-Sha256': 'f'.repeat(64) },
      data: body,
    },
    {
      name: 'missing protocol',
      code: 202,
      head: {
        'Content-Type': 'application/json',
        'X-Sales-Source-Sha256': sourcePayloadHash(event),
      },
      data: body,
    },
    {
      name: 'duplicate protocol header',
      code: 202,
      head: [
        'Content-Type',
        'application/json',
        'X-Sales-Receipt',
        'source-v1',
        'X-Sales-Receipt',
        'source-v1',
        'X-Sales-Source-Sha256',
        sourcePayloadHash(event),
      ],
      data: body,
    },
    { name: 'MIME', code: 202, head: { ...headers(), 'Content-Type': 'text/plain' }, data: body },
    { name: 'redirect', code: 302, head: { ...headers(), Location: '/other' }, data: body },
    { name: 'server error', code: 503, head: headers(), data: body },
    { name: 'wrong state', code: 202, head: headers(), data: body.replace('queued', 'accepted') },
    { name: 'boolean task id', code: 202, head: headers(), data: body.replace('42', 'true') },
    {
      name: 'nonhex run',
      code: 202,
      head: headers(),
      data: body.replace('a'.repeat(32), 'g'.repeat(32)),
    },
    { name: 'extra field', code: 202, head: headers(), data: body.slice(0, -1) + ',"extra":true}' },
    {
      name: 'duplicate JSON field',
      code: 202,
      head: headers(),
      data: body.slice(0, -1) + ',"task_id":42}',
    },
    { name: 'oversized valid JSON', code: 202, head: headers(), data: body + ' '.repeat(17000) },
  ];
  for (const scenario of scenarios)
    await t.test(scenario.name, async () => {
      let calls = 0;
      const server = await serverFixture((_request, reply) => {
        calls++;
        reply.writeHead(scenario.code, scenario.head);
        reply.end(scenario.data);
      });
      try {
        await assert.rejects(
          new HttpInquirySender(server.endpoint, 's'.repeat(48), 'test').send(event),
          /^Error: Sales intake unavailable$/,
        );
        assert.equal(calls, 1, 'a redirect must not create a second request');
      } finally {
        await server.close();
      }
    });
});

test('only explicit test loopback HTTP is accepted and target overrides are unavailable', () => {
  for (const endpoint of [
    'http://remote.invalid/sales/events',
    'https://user@host.invalid/sales/events',
    'https://host.invalid/sales/events?client=other',
    'https://host.invalid/other',
    'https://host.invalid/sales/events#secret',
  ])
    assert.throws(() => new HttpInquirySender(endpoint, 's'.repeat(48), 'test'));
  assert.throws(
    () => new HttpInquirySender('http://127.0.0.1:9000/sales/events', 's'.repeat(48), 'production'),
  );
  assert.throws(
    () => new HttpInquirySender('https://host.invalid/sales/events', 'short', 'production'),
  );
});

test('proxy environment does not receive the source credential', async () => {
  let proxyCalls = 0;
  let targetCalls = 0;
  const proxy = await serverFixture((_request, reply) => {
    proxyCalls++;
    reply.writeHead(500);
    reply.end();
  });
  const target = await serverFixture((_request, reply) => {
    targetCalls++;
    reply.writeHead(202, headers());
    reply.end(body);
  });
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NODE_USE_ENV_PROXY'];
  const prior = names.map((name) => process.env[name]);
  names.forEach((name) => {
    process.env[name] = name === 'NODE_USE_ENV_PROXY' ? '1' : proxy.endpoint;
  });
  try {
    await new HttpInquirySender(target.endpoint, 's'.repeat(48), 'test').send(event);
    assert.equal(targetCalls, 1);
    assert.equal(proxyCalls, 0);
  } finally {
    names.forEach((name, i) => {
      const old = prior[i];
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    });
    await target.close();
    await proxy.close();
  }
});

test('absolute deadline rejects an otherwise valid continuously trickled body', async () => {
  const server = await serverFixture((_request, reply) => {
    reply.writeHead(202, headers());
    let index = 0;
    const timer = setInterval(() => {
      reply.write(body[index++] ?? '');
      if (index >= body.length) {
        clearInterval(timer);
        reply.end();
      }
    }, 10);
    reply.on('close', () => clearInterval(timer));
  });
  try {
    await assert.rejects(
      new HttpInquirySender(server.endpoint, 's'.repeat(48), 'test', 50).send(event),
      /Sales intake unavailable/,
    );
  } finally {
    await server.close();
  }
});
