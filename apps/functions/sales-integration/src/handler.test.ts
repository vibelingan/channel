import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './test-fixtures.ts';

test('oem inquiry returns an allowlisted view and authenticated attachment reference', async () => {
  const s = await setup();
  const response = await s.handler(s.request());
  assert.equal(response.status, 200);
  const view = JSON.parse(response.body.toString()).data;
  assert.equal(view.contact.email, 'buyer@example.invalid');
  assert.equal(view.requirements.quantity_text, '500');
  assert.equal(view.assets.length, 1);
  for (const secret of [
    'uploadSecret',
    'never-project-private-fields',
    'cloud://',
    'storageFileId',
  ])
    assert.ok(!response.body.toString().includes(secret));
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
  assert.equal(
    response.headers.Vary,
    'Authorization, X-Sales-Connection-Id, X-Sales-Context, X-Sales-Task, X-Sales-Lease',
  );
});

test('saved quote snapshot survives a current product change and admin update', async () => {
  const s = await setup();
  const request = s.request(`/inquiries/product/${s.quoteId}`);
  const first = await s.handler(request);
  assert.equal(first.status, 200);
  const view = JSON.parse(first.body.toString()).data;
  assert.equal(view.product_snapshot.revision, 'r1');
  assert.ok(!first.body.toString().includes('privateSupplierCost'));
  assert.ok(!s.calls.some((call) => call.startsWith('product/')));
  s.quote.status = 'in_progress';
  s.quote.version = 1;
  s.quote.events.push({
    id: '00000000-0000-4000-8000-000000000001',
    actorId: 'admin',
    actorName: 'Admin',
    at: s.oem.createdAt,
    from: 'new',
    to: 'in_progress',
    version: 1,
  });
  s.rows.set(`catalogQuoteRequests/${s.quoteId}`, s.quote);
  const next = JSON.parse((await s.handler(request)).body.toString()).data;
  assert.equal(next.source_revision, view.source_revision);
  assert.equal(next.record_status, 'in_progress');
});

test('wrong client context and another installation credential cannot read the database', async () => {
  const s = await setup();
  const request = s.request();
  request.headers['x-sales-context'] = Buffer.from(
    JSON.stringify({
      client_id: 'client_b',
      business_line: 'website_sales',
      source_installation_id: 'site_b',
      runtime_id: 'runtime_b',
      environment: 'test',
      control_epoch: 1,
    }),
  ).toString('base64url');
  assert.equal((await s.handler(request)).status, 403);
  request.headers.authorization = `Bearer ${'b'.repeat(48)}`;
  request.headers['x-sales-connection-id'] = 'agent_b';
  assert.equal((await s.handler(request)).status, 403);
  assert.deepEqual(s.calls, []);
});

test('unfinished, rolled-back, legacy or foreign-owner attachments are unavailable', async () => {
  for (const patch of [
    { status: 'pending' },
    { status: 'failed' },
    { ownerProjectId: 'oem_b' },
    { storageProvider: 'unknown' },
    { storageFileId: 'https://outside.invalid/file' },
    { purpose: 'catalog-image' },
  ]) {
    const s = await setup();
    s.rows.set('files/drawing_a', { ...s.file, ...patch });
    assert.equal((await s.handler(s.request())).status, 404);
    assert.ok(!s.calls.some((call) => call.startsWith('cloud://')));
  }
});

test('asset route returns verified bytes and rejects tampering or stale references', async () => {
  const s = await setup();
  const view = JSON.parse((await s.handler(s.request())).body.toString()).data;
  const request = s.request(`/assets/${view.assets[0].ref}`);
  const result = await s.handler(request);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, s.pdf);
  assert.ok(result.headers['Content-Disposition']?.startsWith('attachment;'));
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  s.setDownload(Buffer.from('different bytes'));
  assert.equal((await s.handler(request)).status, 404);
  s.setDownload(s.pdf);
  s.rows.set('oemProjects/oem_a', { ...s.oem, category: 'changed' });
  assert.equal((await s.handler(request)).status, 409);
});

test('asset ranges return only the requested verified bytes and reject ambiguous ranges', async () => {
  const s = await setup();
  const view = JSON.parse((await s.handler(s.request())).body.toString()).data;
  const request = s.request(`/assets/${view.assets[0].ref}`);
  request.headers.range = 'bytes=0-7';
  const partial = await s.handler(request);
  assert.equal(partial.status, 206);
  assert.deepEqual(partial.body, s.pdf.subarray(0, 8));
  assert.equal(partial.headers['Content-Range'], `bytes 0-7/${s.pdf.byteLength}`);
  assert.equal(partial.headers['Accept-Ranges'], 'bytes');
  request.headers.range = 'bytes=8-9999';
  const tail = await s.handler(request);
  assert.equal(tail.status, 206);
  assert.deepEqual(tail.body, s.pdf.subarray(8));
  for (const [range, status] of [
    ['bytes=9999-10000', 416],
    ['bytes=8-7', 416],
    ['bytes=0-1,4-7', 403],
    ['bytes=-8', 403],
    ['bytes=0-', 403],
    ['bytes=0-9007199254740992', 416],
    ['items=0-7', 403],
  ] as const) {
    request.headers.range = range;
    const invalid = await s.handler(request);
    assert.equal(invalid.status, status, range);
    if (status === 416)
      assert.equal(invalid.headers['Content-Range'], `bytes */${s.pdf.byteLength}`);
  }
  s.registry.enabled = false;
  assert.equal((await s.handler(request)).status, 403);
});

test('product query uses the approved reader without accepting raw database queries', async () => {
  const s = await setup();
  const request = {
    ...s.request('/products/query'),
    method: 'POST',
    body: Buffer.from(
      JSON.stringify({
        ids: [{ id: 'product_a', revision: 'r2' }],
        page: 1,
        page_size: 20,
      }),
    ),
  };
  request.headers['content-type'] = 'application/json';
  const response = await s.handler(request);
  assert.equal(response.status, 200);
  assert.ok(s.calls.includes('product/product_a/1/20/r2'));
  request.body = Buffer.from('{"collection":"users","filter":{}}');
  assert.equal((await s.handler(request)).status, 400);
});

test('missing auth, duplicate header identity, oversized body and arbitrary URL never read data', async () => {
  const s = await setup();
  const request = s.request();
  request.headers.authorization = undefined;
  assert.equal((await s.handler(request)).status, 401);
  request.headers.authorization = `Bearer ${'a'.repeat(48)}`;
  request.headers.Authorization = `Bearer ${'b'.repeat(48)}`;
  assert.equal((await s.handler(request)).status, 401);
  assert.equal(
    (
      await s.handler({
        ...s.request('/products/query'),
        method: 'POST',
        body: Buffer.alloc(16385),
      })
    ).status,
    413,
  );
  assert.equal((await s.handler(s.request('/assets/https://outside.invalid'))).status, 404);
  assert.deepEqual(s.calls, []);
});

test('revocation takes effect between calls', async () => {
  const s = await setup();
  assert.equal((await s.handler(s.request())).status, 200);
  const before = s.calls.length;
  s.registry.enabled = false;
  assert.equal((await s.handler(s.request())).status, 403);
  assert.equal(s.calls.length, before);
});

test('source records declaring another client are denied and provider errors do not leak', async () => {
  const s = await setup();
  for (const patch of [
    { client_id: 'client_b' },
    { source_installation_id: 'site_b' },
    { business_line: 'cold_outreach' },
  ]) {
    s.rows.set('oemProjects/oem_a', { ...s.oem, ...patch });
    assert.equal((await s.handler(s.request())).status, 404);
  }
  s.rows.set('oemProjects/oem_a', s.oem);
  s.setReadFailure();
  const failure = await s.handler(s.request());
  assert.equal(failure.status, 503);
  assert.ok(!failure.body.toString().includes('private-provider-error'));
});

test('a different authorized business line cannot reuse the website inquiry endpoint', async () => {
  const s = await setup();
  s.registry.bindings[0].business_lines.push('cold_outreach');
  const request = s.request();
  request.headers['x-sales-context'] = Buffer.from(
    JSON.stringify({
      client_id: 'client_a',
      business_line: 'cold_outreach',
      source_installation_id: 'site_a',
      runtime_id: 'runtime_a',
      environment: 'test',
      control_epoch: 1,
    }),
  ).toString('base64url');
  assert.equal((await s.handler(request)).status, 403);
  assert.deepEqual(s.calls, []);
});
