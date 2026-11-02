import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { issueTaskPermit } from '@vibelingan-channel/sales-contracts/task-access';
import { validateContract } from '@vibelingan-channel/sales-contracts';
import { createSalesRuntime } from './index.ts';
import { issueSourceGrant } from './source-grants.ts';
import { createCloudBaseSourceGrantStore } from './source-grant-store.ts';
import { grantFixture } from './source-grant-fixtures.ts';
import { createWebsiteFixture } from './website-test-fixtures.ts';

test('actual createSalesRuntime reads an unregistered private product inquiry through its SDK port', async () => {
  const s = createWebsiteFixture();
  assert.equal((await s.submitProduct()).statusCode, 200);
  const registration = s.registrations()[0];
  assert.ok(registration);
  const now = () => Math.floor(Date.now() / 1000);
  const token = Buffer.alloc(32, 7).toString('base64url');
  const old = await grantFixture();
  const granted = await issueSourceGrant(
    {
      ...old.dependencies,
      loadCredential: async (ref) => (ref === 'env:AGENT_a' ? 'a'.repeat(48) : 'b'.repeat(48)),
      sourceGrants: {
        enabled: true,
        token: 'g'.repeat(48),
        forbiddenTokens: ['c'.repeat(48)],
        store: createCloudBaseSourceGrantStore(s.database),
        now,
      },
    },
    {
      ...old.body,
      event: registration.event,
      lease_sha256: createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex'),
    },
  );
  const base = JSON.parse(
    readFileSync(
      new URL('../../../../packages/sales-contracts/fixtures/task-access.json', import.meta.url),
      'utf8',
    ),
  );
  const authority = validateContract('sales-auth-authority', {
    ...base.authority,
    task_id: granted.lease.task_id,
    run_id: granted.lease.run_id,
    task_revision: granted.lease.task_revision,
    handoff_sha256: granted.lease.handoff_sha256,
  });
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const value = JSON.parse(Buffer.concat(chunks).toString());
      const permit = issueTaskPermit(value, authority, now());
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(permit));
    } catch {
      response.writeHead(403);
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const require = createRequire(new URL('../../../../packages/db/package.json', import.meta.url));
  const sdkRequire = createRequire(require.resolve('@cloudbase/node-sdk/package.json'));
  const Request = sdkRequire(
    join(
      dirname(sdkRequire.resolve('@cloudbase/node-sdk/package.json')),
      'dist/utils/tcbdbapirequester.js',
    ),
  ).TcbDBApiHttpRequester;
  const original = Request.prototype.send;
  const calls: string[] = [];
  const environment = {
    SALES_INTEGRATION_ENABLED: '1',
    SALES_CLIENT_ID: 'client_a',
    SALES_BUSINESS_LINE: 'website_sales',
    SALES_INSTALLATION_ID: 'site_a',
    TCB_ENV: 'env_a',
    SALES_ENVIRONMENT: 'test',
    SALES_STORAGE_HOSTS: 'storage.example.invalid',
    SALES_HERMES_AUTH_URL: `http://127.0.0.1:${address.port}/sales/authorize-read`,
    SALES_HERMES_AUTH_TOKEN: 'c'.repeat(48),
    AGENT_a: 'a'.repeat(48),
    SALES_SOURCE_GRANTS_ENABLED: '0',
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, environment);
    Request.prototype.send = async function (
      name: string,
      param: { collectionName: string; query: string },
    ) {
      assert.equal(name, 'database.getDocument');
      const id = JSON.parse(param.query)._id;
      const key = `${param.collectionName}/${id}`;
      calls.push(key);
      const row = s.rows.get(key);
      return { data: { list: row ? [JSON.stringify(row)] : [] } };
    };
    const runtime = createSalesRuntime();
    const response = await runtime({
      method: 'GET',
      url: `/integrations/sales/inquiries/product/${registration.source.id}`,
      headers: {
        authorization: `Bearer ${'a'.repeat(48)}`,
        'x-sales-connection-id': 'agent_a',
        'x-sales-context': Buffer.from(
          JSON.stringify({
            client_id: 'client_a',
            business_line: 'website_sales',
            source_installation_id: 'site_a',
            runtime_id: 'runtime_a',
            environment: 'test',
            control_epoch: 1,
          }),
        ).toString('base64url'),
        'x-sales-lease': token,
        'x-sales-task': Buffer.from(
          JSON.stringify({
            protocol: 'sales-auth/1',
            task_id: granted.lease.task_id,
            run_id: granted.lease.run_id,
            task_revision: granted.lease.task_revision,
            request_id: 'f'.repeat(32),
          }),
        ).toString('base64url'),
      },
    });
    assert.equal(response.status, 200, JSON.stringify({ body: response.body.toString(), calls }));
    assert.equal(
      JSON.parse(response.body.toString()).data.source_record_id,
      registration.source.id,
    );
    assert.ok(calls.includes(`catalogQuoteRequests/${registration.source.id}`));
  } finally {
    Request.prototype.send = original;
    for (const [key, value] of previous)
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
