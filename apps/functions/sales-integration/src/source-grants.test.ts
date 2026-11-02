import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { validateContract } from '@vibelingan-channel/sales-contracts';
import { canonicalInquiryEvent } from './canonical-source-event.ts';
import { createSalesHandler } from './handler.ts';
import { createSalesServer } from './server.ts';
import { grantFixture } from './source-grant-fixtures.ts';
import { setup } from './test-fixtures.ts';

test('source grant route is absent by default and read credentials cannot bootstrap', async () => {
  const ordinary = await setup();
  const s = await grantFixture();
  assert.equal((await ordinary.handler(s.request())).status, 404);
  for (const token of ['a'.repeat(48), 'c'.repeat(48), 'x'.repeat(48)])
    assert.equal((await s.handler(s.request(s.body, token))).status, 401);
  assert.equal(s.store.entered, 0);
});

test('source grant persists existing handoff and lease contracts with server TTL', async () => {
  const s = await grantFixture('product');
  const response = await s.handler(s.request());
  assert.equal(response.status, 200, response.body.toString());
  const result = JSON.parse(response.body.toString());
  const lease = validateContract('sales-auth-lease', result.lease);
  validateContract('sales-auth-handoff', result.handoff);
  assert.equal(result.request_id, s.body.request_id);
  assert.equal(lease.task_id, '1');
  assert.equal(lease.run_id, s.body.run_id);
  assert.equal(lease.issued_at, 1700000000);
  assert.equal(lease.expires_at, 1700000300);
  assert.equal(lease.product_scope, 'approved_catalog');
  assert.ok(lease.allowed_actions.includes('inquiry.read'));
  assert.ok(lease.allowed_actions.includes('product.read'));
  assert.deepEqual(s.store.rows.get(`channelSalesTaskLeases/${lease.lease_sha256}`), {
    _id: lease.lease_sha256,
    record: lease,
  });
  assert.ok(!response.body.toString().includes('g'.repeat(48)));
  assert.ok(!response.body.toString().includes('a'.repeat(48)));
});

test('exact retry returns original grant without sliding expiry and expired hash is refused', async () => {
  const s = await grantFixture();
  const first = await s.handler(s.request());
  assert.equal(first.status, 200);
  s.setNow(1700000010);
  const retry = await s.handler(s.request());
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, first.body);
  s.setNow(1700000300);
  assert.equal((await s.handler(s.request())).status, 403);
  assert.deepEqual(s.store.rows.get(`channelSalesTaskLeases/${s.body.lease_sha256}`), {
    _id: s.body.lease_sha256,
    record: JSON.parse(first.body.toString()).lease,
  });
});

test('request and lease hash reuse cannot change task or event identity', async () => {
  const s = await grantFixture();
  assert.equal((await s.handler(s.request())).status, 200);
  for (const patch of [
    { task_id: '2' },
    { request_id: '3'.repeat(32) },
    { event: { ...s.body.event, event_id: 'another transport' } },
  ]) {
    const response = await s.handler(s.request({ ...s.body, ...patch }));
    assert.equal(response.status, 409);
  }
});

test('grant scope, current runtime and strict request fields cannot be supplied by a model', async () => {
  const s = await grantFixture();
  for (const patch of [
    { client_id: 'client_b' },
    { runtime_id: 'runtime_b' },
    { environment: 'production' },
    { control_epoch: 2 },
    { connection_id: 'agent_b' },
  ])
    assert.equal((await s.handler(s.request({ ...s.body, ...patch }))).status, 403);
  for (const patch of [
    { source_verified: true },
    { task_revision: 0 },
    { task_id: '01' },
    { task_id: '9007199254740992' },
    { run_id: 'not-a-run' },
    { request_id: 'short' },
  ])
    assert.equal((await s.handler(s.request({ ...s.body, ...patch }))).status, 400);
  assert.equal(
    [...s.store.rows.keys()].filter((x) => x.startsWith('channelSalesTaskLeases/')).length,
    0,
  );
});

test('missing or conflicting record ownership is denied even with active installation', async () => {
  for (const patch of [
    { client_id: undefined },
    { business_line: 'other' },
    { source_installation_id: 'site_b' },
  ]) {
    const s = await grantFixture();
    s.store.rows.set('oemProjects/oem_a', { ...s.oem, ...patch });
    assert.equal((await s.handler(s.request())).status, 403);
  }
});

test('OEM requires final matching submission marker, active file and nonterminal source', async () => {
  for (const patch of [
    { salesSubmissionState: undefined },
    { salesSubmittedRevision: 'bad' },
    { status: 'closed' },
  ]) {
    const s = await grantFixture();
    s.store.rows.set('oemProjects/oem_a', { ...s.oem, ...patch });
    assert.equal((await s.handler(s.request())).status, 403);
  }
  const s = await grantFixture();
  s.store.rows.set('files/drawing_a', { ...s.file, status: 'pending' });
  assert.equal((await s.handler(s.request())).status, 403);
});

test('canonical source facts rather than claimed summary, recipient or channel determine authorization', async () => {
  const s = await grantFixture();
  for (const event of [
    {
      ...s.body.event,
      contact: { ...s.body.event.contact, email: 'foreign@example.invalid' },
    },
    {
      ...s.body.event,
      requirements: {
        confirmed_summary: 'model invented a different purchase',
      },
    },
    { ...s.body.event, source: 'website_assistant' },
    { ...s.body.event, submitted_at: '2026-10-24T00:00:00.000Z' },
    { ...s.body.event, attachment_refs: [] },
  ])
    assert.equal((await s.handler(s.request({ ...s.body, event }))).status, 403);
  assert.equal(
    (
      await s.handler(
        s.request({
          ...s.body,
          event: {
            ...s.body.event,
            event_id: 'transport can change before first delivery',
          },
        }),
      )
    ).status,
    200,
  );
});

test('revoked handoff or lease cannot be revived by retry or a new token', async () => {
  const s = await grantFixture();
  const first = await s.handler(s.request());
  const reply = JSON.parse(first.body.toString());
  s.store.rows.set(`channelSalesSourceHandoffs/${reply.handoff.handoff_sha256}`, {
    record: { ...reply.handoff, state: 'revoked' },
  });
  const next = {
    ...s.body,
    request_id: '4'.repeat(32),
    lease_sha256: 'd'.repeat(64),
  };
  assert.equal((await s.handler(s.request(next))).status, 403);
  assert.equal((await s.handler(s.request())).status, 403);
  const t = await grantFixture();
  const second = JSON.parse((await t.handler(t.request())).body.toString());
  t.store.rows.set(`channelSalesTaskLeases/${second.lease.lease_sha256}`, {
    record: { ...second.lease, revoked: true },
  });
  assert.equal((await t.handler(t.request())).status, 403);
});

test('changed source, installation or binding cannot reuse a still-unexpired grant', async () => {
  for (const target of ['source', 'installation', 'binding'] as const) {
    const s = await grantFixture();
    assert.equal((await s.handler(s.request())).status, 200);
    if (target === 'source')
      s.store.rows.set('oemProjects/oem_a', { ...s.oem, category: 'changed' });
    if (target === 'installation')
      s.store.rows.set('channelSalesInstallations/site_a', {
        record: {
          client_id: 'client_a',
          business_line: 'website_sales',
          source_installation_id: 'site_a',
          environment: 'test',
          cloud_env_id: 'env_b',
          state: 'active',
        },
      });
    if (target === 'binding')
      s.store.rows.set('channelSalesBindings/site_a', {
        registry: { ...s.registry, enabled: false },
      });
    assert.equal((await s.handler(s.request())).status, 403);
  }
});

test('storage fault rolls back all new authority records; concurrent retries converge', async () => {
  const s = await grantFixture();
  s.store.failWrites = true;
  assert.equal((await s.handler(s.request())).status, 503);
  assert.equal(
    [...s.store.rows.keys()].filter((x) =>
      /channelSales(?:TaskLeases|SourceHandoffs|SourceGrantRequests)\//.test(x),
    ).length,
    0,
  );
  s.store.failWrites = false;
  const results = await Promise.all([s.handler(s.request()), s.handler(s.request())]);
  assert.deepEqual(
    results.map((x) => x.status),
    [200, 200],
  );
  assert.deepEqual(results[0]?.body, results[1]?.body);
});

test('backend grant secret cannot be configured as a runtime or permit secret', async () => {
  const s = await grantFixture();
  for (const token of ['a'.repeat(48), 'c'.repeat(48)]) {
    const handler = createSalesHandler({
      ...s.dependencies,
      sourceGrants: { ...s.dependencies.sourceGrants, token },
    });
    assert.equal((await handler(s.request(s.body, token))).status, 403);
  }
});

test('failure at every transaction write leaves no partial authority and permits a clean retry', async () => {
  for (const failAtWrite of [1, 2, 3, 4]) {
    const s = await grantFixture();
    const before = structuredClone(s.store.rows);
    s.store.failAtWrite = failAtWrite;
    const failed = await s.handler(s.request());
    assert.equal(failed.status, 503, String(failAtWrite));
    assert.deepEqual(
      s.store.rows,
      before,
      `write ${failAtWrite} must not commit earlier staged writes`,
    );
    s.store.failAtWrite = undefined;
    const retried = await s.handler(s.request());
    assert.equal(retried.status, 200, retried.body.toString());
    assert.equal(
      [...s.store.rows.keys()].filter((key) =>
        /^channelSales(?:TaskLeases|SourceHandoffs|SourceGrantRequests)\//.test(key),
      ).length,
      4,
    );
  }
});

test('canonical event references submitted snapshot and excludes mutable admin notes', async () => {
  const s = await grantFixture('product');
  const altered = {
    ...s.view,
    record_status: 'in_progress',
    requirements: { ...s.view.requirements },
  };
  assert.deepEqual(canonicalInquiryEvent(s.body, altered), s.body.event);
  assert.equal(s.body.event.product_snapshot_refs.length, 1);
  assert.ok(s.body.event.product_snapshot_refs[0]?.startsWith('snapshot:'));
});

test('HTTP grant route permits its bounded larger body while old read route remains 16KiB', async () => {
  const s = await grantFixture();
  const server = createSalesServer(s.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const body = JSON.stringify(s.body) + ' '.repeat(20000);
    const headers = {
      authorization: `Bearer ${'g'.repeat(48)}`,
      'content-type': 'application/json',
    };
    const result = await fetch(origin + '/integrations/sales/source-grants', {
      method: 'POST',
      headers,
      body,
    });
    assert.equal(result.status, 200);
    await result.arrayBuffer();
    const old = await fetch(origin + '/products/query', {
      method: 'POST',
      headers,
      body,
    });
    assert.equal(old.status, 413);
    await old.arrayBuffer();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('source grant rejects corrupt stored authority instead of overwriting it', async () => {
  const s = await grantFixture();
  const result = JSON.parse((await s.handler(s.request())).body.toString());
  for (const collection of ['channelSalesTaskLeases', 'channelSalesSourceHandoffs'] as const) {
    const target =
      collection === 'channelSalesTaskLeases' ? s.body.lease_sha256 : result.handoff.handoff_sha256;
    const before = structuredClone(s.store.rows);
    s.store.rows.set(`${collection}/${target}`, { revoked: true });
    assert.equal((await s.handler(s.request())).status, 403);
    assert.deepEqual(s.store.rows.get(`${collection}/${target}`), {
      revoked: true,
    });
    s.store.rows = before;
  }
});

test('binding has one active runtime connection and cannot add model publishing authority', async () => {
  for (const change of [
    'operator',
    'no_product',
    'second_runtime',
    'duplicate_client',
    'shared_runtime',
  ] as const) {
    const s = await grantFixture();
    const registry = structuredClone(s.registry);
    const binding = registry.bindings[0];
    if (change === 'operator') binding.connections[0].actor = { kind: 'operator', id: 'sales_a' };
    if (change === 'no_product') binding.connections[0].actions = ['inquiry.read'];
    if (change === 'second_runtime')
      binding.connections.push({
        ...binding.connections[0],
        connection_id: 'other_runtime',
        credential_ref: 'env:OTHER',
      });
    if (change === 'duplicate_client') registry.bindings.push(structuredClone(binding));
    if (change === 'shared_runtime') registry.bindings[1].runtime_id = binding.runtime_id;
    s.store.rows.set('channelSalesBindings/site_a', { registry });
    assert.equal((await s.handler(s.request())).status, 403, change);
    assert.equal(
      [...s.store.rows.keys()].filter((x) => x.startsWith('channelSalesTaskLeases/')).length,
      0,
    );
  }
});

test('canonical quantity uses only unambiguous positive integers through the contract maximum', async () => {
  const s = await grantFixture();
  for (const [text, expected] of [
    ['1000000000', 1000000000],
    ['1', 1],
    ['1000000001', undefined],
    ['01', undefined],
    ['500 pcs', undefined],
    ['0', undefined],
    ['1.5', undefined],
    ['', undefined],
  ] as const) {
    const view = {
      ...s.view,
      requirements: { ...s.view.requirements, quantity_text: text },
    };
    assert.equal(canonicalInquiryEvent(s.body, view).requirements.quantity, expected, text);
  }
});

test('realistic long OEM identifiers survive canonical grant creation', async () => {
  const s = await grantFixture();
  const projectId = 'o'.repeat(32),
    fileId = 'f'.repeat(32);
  const oem = { ...s.oem, _id: projectId, drawing: fileId };
  s.store.rows.set(`oemProjects/${projectId}`, oem);
  s.store.rows.set(`files/${fileId}`, {
    ...s.file,
    _id: fileId,
    ownerProjectId: projectId,
  });
  const view = (await import('./sources.ts')).readInquiry(
    {
      ...s.dependencies,
      readDoc: async (collection, id) => {
        const result = s.store.rows.get(`${collection}/${id}`);
        return result && typeof result === 'object' && '_id' in result
          ? (result as typeof s.oem)
          : null;
      },
    },
    'oem',
    projectId,
  );
  const source = (await view).view;
  s.store.rows.set(`oemProjects/${projectId}`, {
    ...oem,
    salesSubmittedRevision: source.source_revision,
  });
  const event = canonicalInquiryEvent(s.body, source);
  assert.equal(event.attachment_refs[0]?.length, 236);
  const reply = await s.handler(s.request({ ...s.body, event }));
  assert.equal(reply.status, 200, reply.body.toString());
  assert.deepEqual(JSON.parse(reply.body.toString()).lease.asset_refs, event.attachment_refs);
});
