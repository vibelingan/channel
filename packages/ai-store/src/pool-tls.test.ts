import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type Socket, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TLSSocket, createSecureContext } from 'node:tls';
import { createAiPool } from './pool.ts';
import { AiStore } from './store.ts';

// Exercise pg's real SSLRequest -> TLS upgrade, not a mock of tls.connect.
// Only the PostgreSQL authentication/ready frames are simulated: no DB needed.
async function withTlsPostgres(
  certificateIp: string,
  run: (connectionString: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'channel-pg-tls-'));
  const certificate = join(directory, 'server.crt');
  const key = join(directory, 'server.key');
  const sockets = new Set<Socket>();
  const server = createServer();
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        key,
        '-out',
        certificate,
        '-subj',
        `/CN=${certificateIp}`,
        '-addext',
        `subjectAltName=IP:${certificateIp}`,
      ],
      { stdio: 'ignore' },
    );
    const secureContext = createSecureContext({
      key: readFileSync(key),
      cert: readFileSync(certificate),
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let request = Buffer.alloc(0);
      const sslRequest = (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        if (request.length < 8) return;
        socket.off('data', sslRequest);
        assert.equal(request.readInt32BE(0), 8);
        assert.equal(request.readInt32BE(4), 80877103);
        socket.write('S');
        const secured = new TLSSocket(socket, { isServer: true, secureContext });
        // Rejection of the server's identity is an expected negative case.
        secured.on('error', () => secured.destroy());
        secured.once('data', () => {
          const authenticated = Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0]);
          const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
          secured.write(Buffer.concat([authenticated, ready]));
        });
      };
      socket.on('data', sslRequest);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = new URL(`postgres://test:test@127.0.0.1:${address.port}/test`);
    url.searchParams.set('sslmode', 'verify-full');
    url.searchParams.set('sslrootcert', certificate);
    await run(url.toString());
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

test('verify-full accepts a trusted certificate for the actual PostgreSQL IP', async () => {
  await withTlsPostgres('127.0.0.1', async (connectionString) => {
    const pool = createAiPool({ connectionString, connectionTimeoutMillis: 2000 });
    try {
      const client = await pool.connect();
      client.release();
    } finally {
      await pool.end();
    }
  });
});

test('the BFF/worker store uses the same verified IP TLS connection', async () => {
  await withTlsPostgres('127.0.0.1', async (connectionString) => {
    const store = new AiStore(connectionString, 1);
    try {
      const client = await store.pool.connect();
      client.release();
    } finally {
      await store.close();
    }
  });
});

test('verify-full still rejects a trusted certificate for a different IP', async () => {
  await withTlsPostgres('127.0.0.2', async (connectionString) => {
    const pool = createAiPool({ connectionString, connectionTimeoutMillis: 2000 });
    try {
      await assert.rejects(pool.connect(), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    } finally {
      await pool.end();
    }
  });
});

test('verify-full still rejects an untrusted certificate with a matching IP', async () => {
  await withTlsPostgres('127.0.0.1', async (connectionString) => {
    const url = new URL(connectionString);
    url.searchParams.delete('sslrootcert');
    const pool = createAiPool({ connectionString: url.toString(), connectionTimeoutMillis: 2000 });
    try {
      await assert.rejects(pool.connect(), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    } finally {
      await pool.end();
    }
  });
});
