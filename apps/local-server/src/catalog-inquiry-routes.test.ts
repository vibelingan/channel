import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import {
  InquiryDataSchema,
  InquiryEnvelopeSchema,
} from '@vibelingan-channel/shared/catalog-inquiry';
import express from 'express';
import { z } from 'zod';
import { bootstrapLocalInquiryAdmin } from './catalog-inquiry-bootstrap.ts';
import { registerLocalInquiryRoutes } from './catalog-inquiry-routes.ts';
import { closeServer } from './catalog-routes.ts';
import { JsonFileAdapter } from './json-adapter.ts';

test('real HTTP login, protected inquiries and revocation; local bootstrap is stable and private', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-rfq-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new JsonFileAdapter(join(dir, 'db.json'));
  setAdapter(db);
  const config = await bootstrapLocalInquiryAdmin(db, dir);
  const credentials = JSON.parse(readFileSync(join(dir, 'local-admin.json'), 'utf8'));
  assert.equal(statSync(join(dir, 'local-admin.json')).mode & 0o777, 0o600);
  assert.deepEqual(await bootstrapLocalInquiryAdmin(db, dir), config);
  const app = express();
  registerLocalInquiryRoutes(app, db, config);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => closeServer(server));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/admin`;
  const headers = { origin: 'http://127.0.0.1:4328', 'content-type': 'application/json' };
  const call = async (body: unknown, origin = headers.origin) =>
    fetch(url, {
      method: 'POST',
      headers: { ...headers, origin },
      body: JSON.stringify(body),
    });
  assert.equal((await call({ action: 'inquiry', data: { action: 'list' } })).status, 401);
  assert.equal((await call({ action: 'me' }, 'https://evil.test')).status, 403);
  assert.equal((await fetch(url)).status, 403);
  assert.equal(
    (await call({ action: 'inquiry', token: 'fake', data: { action: 'list' } })).status,
    401,
  );
  const login = z
    .object({
      ok: z.literal(true),
      data: z.object({ token: z.string(), user: z.object({ id: z.string() }) }),
    })
    .parse(
      await (
        await call({
          action: 'login',
          data: { email: credentials.email, password: credentials.password },
        })
      ).json(),
    );
  assert.equal(login.ok, true);
  const token = login.data.token;
  const capabilities = await call({ action: 'inquiryCapabilities', token });
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), {
    ok: true,
    data: { enabled: true, notification: 'disabled' },
  });
  const list = await call({ action: 'inquiry', token, data: { action: 'list' } });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const listData = z.object({ data: InquiryDataSchema }).parse(await list.json()).data;
  assert.ok(listData.kind === 'list');
  assert.deepEqual(listData.items, []);
  const inquiryId = randomUUID();
  await db.create('catalogQuoteRequests', {
    _id: inquiryId,
    schemaVersion: 'catalog-quote-request-v1',
    keyHash: 'private-dedup-hash',
    fingerprint: 'private-fingerprint',
    target: { intent: 'variant_quote', productId: 'p1', revision: 'r1', variantId: 'v1' },
    fields: {
      intent: 'variant_quote',
      quantity: '500',
      deliveryDate: '',
      customizationTypes: [],
      brief: '',
      contactName: 'HTTP Test Buyer',
      company: 'Test Co',
      email: 'buyer@example.test',
      country: 'HK',
    },
    snapshot: {
      productId: 'p1',
      revision: 'r1',
      productName: 'HTTP Test Headset',
      images: [],
      productOffers: [],
      variant: {
        id: 'v1',
        options: [{ name: 'Color', value: 'Pink' }],
        images: [],
        inventory: { state: 'unknown' },
        offers: [],
      },
    },
    status: 'new',
    notification: 'disabled-local',
    createdAt: '2026-09-06T16:00:00.000Z',
    updatedAt: '2026-09-06T16:00:00.000Z',
  });
  const inquiry = async (data: unknown) => {
    const response = await call({ action: 'inquiry', token, data });
    const body = InquiryEnvelopeSchema.parse(await response.json());
    assert.doesNotMatch(JSON.stringify(body), /private-dedup-hash|private-fingerprint|operationId/);
    return { status: response.status, body };
  };
  const detail = await inquiry({ action: 'get', id: inquiryId });
  assert.ok(detail.body.ok && detail.body.data.kind === 'detail');
  assert.equal(detail.body.data.item.version, 0);
  const update = {
    action: 'update',
    id: inquiryId,
    version: 0,
    operationId: randomUUID(),
    status: 'in_progress',
    note: 'Contacted buyer',
  };
  const accepted = await inquiry(update);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await inquiry(update), accepted);
  const conflict = await inquiry({ ...update, operationId: randomUUID() });
  assert.equal(conflict.status, 409);
  assert.ok(!conflict.body.ok);
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');
  const noReason = await inquiry({
    ...update,
    version: 1,
    operationId: randomUUID(),
    status: 'closed',
    note: undefined,
  });
  assert.equal(noReason.status, 409);
  assert.ok(!noReason.body.ok);
  assert.equal(noReason.body.error.code, 'REASON_REQUIRED');
  const updated = await inquiry({ action: 'get', id: inquiryId });
  assert.ok(updated.body.ok && updated.body.data.kind === 'detail');
  assert.equal(updated.body.data.item.events.length, 1);
  assert.equal(updated.body.data.item.events[0]?.actorId, login.data.user.id);
  assert.equal(
    (await call({ action: 'remove', token, data: { collection: 'catalogQuoteRequests' } })).status,
    403,
  );
  assert.equal((await call({ action: 'register', data: {} })).status, 403);
  assert.equal(
    (await call({ action: 'inquiry', token, data: { action: 'list', actorId: 'forged' } })).status,
    400,
  );
  const expired = await signSession(
    config.jwtSecret,
    { sub: login.data.user.id, role: 'admin', email: credentials.email, name: 'Admin' },
    -1,
  );
  assert.equal(
    (await call({ action: 'inquiry', token: expired, data: { action: 'list' } })).status,
    401,
  );
  await db.update('users', login.data.user.id, { role: 'contributor' });
  assert.equal((await call({ action: 'inquiry', token, data: { action: 'list' } })).status, 403);
  await db.update('users', login.data.user.id, { role: 'admin', status: 'suspended' });
  assert.equal((await call({ action: 'inquiry', token, data: { action: 'list' } })).status, 401);
  assert.equal((await call({ action: 'login', data: { blob: 'x'.repeat(20000) } })).status, 413);
});
