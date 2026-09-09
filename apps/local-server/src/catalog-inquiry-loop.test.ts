import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setAdapter } from '@vibelingan-channel/db';
import { handlePublicApiEvent } from '@vibelingan-channel/fn-public-api/http-adapter';
import { InquiryEnvelopeSchema } from '@vibelingan-channel/shared/catalog-inquiry';
import express from 'express';
import { z } from 'zod';
import { bootstrapLocalInquiryAdmin } from './catalog-inquiry-bootstrap.ts';
import { registerLocalInquiryRoutes } from './catalog-inquiry-routes.ts';
import { registerLocalQuoteRoutes } from './catalog-quote-routes.ts';
import { closeServer } from './catalog-routes.ts';
import { JsonFileAdapter } from './json-adapter.ts';

const origin = 'http://127.0.0.1:4328';
const headers = { origin, 'content-type': 'application/json', 'x-local-catalog-quote': '1' };
const receiptSchema = z.object({ ok: z.literal(true), requestId: z.string().uuid() }).strict();

// Keep the real HTTP handler, policies, auth and file storage. Only the external
// CloudBase persistence is substituted; these tests do NOT prove cloud commits.
for (const transport of ['local-preview', 'cloud-handler'] as const) {
  test(`${transport}: submit, admin follow-up and restart preserve one inquiry and its authoritative history`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'channel-inquiry-loop-'));
    const servers: Server[] = [];
    t.after(async () => {
      for (const server of servers) if (server.listening) await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    });
    const file = join(directory, 'db.json');
    const initial = new JsonFileAdapter(file);
    await initial.create('products', {
      _id: 'loop-product',
      localDetailClone: true,
      published: true,
      catalogDetailPublication: {
        state: 'approved',
        revision: 'approved-revision',
        variantCount: 1,
        header: {
          schemaVersion: 'catalog-product-detail-v1',
          _id: 'loop-product',
          name: 'Loop test headset',
          images: [],
          facts: [],
          offers: [],
        },
      },
    });
    await initial.create('productVariants', {
      _id: 'loop-variant',
      productId: 'loop-product',
      catalogDetailRevision: 'approved-revision',
      catalogDetailApproved: {
        id: 'loop-variant',
        options: [{ name: 'Color', value: 'Pink' }],
        images: [],
        inventory: { state: 'unknown' },
        offers: [],
      },
    });

    async function start(db: JsonFileAdapter) {
      setAdapter(db);
      const config = await bootstrapLocalInquiryAdmin(db, directory);
      const app = express();
      registerLocalInquiryRoutes(app, db, config);
      if (transport === 'local-preview') registerLocalQuoteRoutes(app, db);
      else {
        app.all('/api/catalog-quote-requests', express.text({ type: '*/*' }), async (req, res) => {
          const result = await handlePublicApiEvent(
            { path: req.path, httpMethod: req.method, headers: req.headers, body: req.body },
            { enableInquiries: true, corsAllowedOrigins: [origin] },
          );
          res.status(result.statusCode).set(result.headers).send(result.body);
        });
      }
      const server = app.listen(0, '127.0.0.1');
      servers.push(server);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const call = async (path: string, body: unknown) => {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        return { status: response.status, body: await response.json() };
      };
      const credentials = z
        .object({ email: z.string(), password: z.string() })
        .parse(JSON.parse(readFileSync(join(directory, 'local-admin.json'), 'utf8')));
      const loggedIn = await call('/api/admin', { action: 'login', data: credentials });
      assert.equal(loggedIn.status, 200);
      const login = z
        .object({ data: z.object({ token: z.string(), user: z.object({ id: z.string() }) }) })
        .parse(loggedIn.body);
      const inquiry = async (data: unknown) => {
        const result = await call('/api/admin', {
          action: 'inquiry',
          token: login.data.token,
          data,
        });
        return { status: result.status, body: InquiryEnvelopeSchema.parse(result.body) };
      };
      return { server, call, inquiry, actorId: login.data.user.id };
    }

    let active = await start(initial);
    const submit = {
      idempotencyKey: randomUUID(),
      target: {
        intent: 'variant_quote',
        productId: 'loop-product',
        revision: 'approved-revision',
        variantId: 'loop-variant',
      },
      fields: {
        intent: 'variant_quote',
        quantity: '500',
        deliveryDate: '',
        customizationTypes: [],
        brief: '',
        contactName: 'Synthetic Buyer',
        company: 'Loop Test',
        email: 'buyer@example.test',
        country: 'HK',
      },
    };
    const path = '/api/catalog-quote-requests';
    const invalid = await active.call(path, {
      ...submit,
      target: { ...submit.target, revision: 'stale' },
    });
    assert.equal(invalid.status, 409);
    assert.equal(z.object({ code: z.string() }).parse(invalid.body).code, 'stale-context');
    assert.equal((await active.call(path, { ...submit, price: 0 })).status, 400);
    const [saved, repeated] = await Promise.all([
      active.call(path, submit),
      active.call(path, submit),
    ]);
    assert.equal(saved.status, 200);
    assert.deepEqual(repeated, saved);
    const { requestId: id } = receiptSchema.parse(saved.body);
    const get = { action: 'get', id };
    const detail = await active.inquiry(get);
    assert.ok(detail.body.ok && detail.body.data.kind === 'detail');
    assert.equal(detail.body.data.item.snapshot.productName, 'Loop test headset');
    assert.equal(detail.body.data.item.snapshot.variant?.options[0]?.value, 'Pink');
    assert.equal(detail.body.data.item.version, 0);
    assert.equal(detail.body.data.item.status, 'new');
    const newCount = async () => {
      const result = await active.inquiry({ action: 'list' });
      assert.ok(result.body.ok && result.body.data.kind === 'list');
      assert.equal(result.body.data.total, 1);
      return result.body.data.newCount;
    };
    assert.equal(await newCount(), 1, 'viewing must not process the inquiry');
    const note = {
      action: 'update',
      id,
      version: 0,
      operationId: randomUUID(),
      note: 'Needs a sales response',
    };
    assert.equal((await active.inquiry(note)).status, 200);
    assert.equal(await newCount(), 1, 'note-only save must keep the attention mark');
    const process = {
      ...note,
      version: 1,
      operationId: randomUUID(),
      status: 'in_progress',
      note: 'Sales is following up',
    };
    assert.equal((await active.inquiry(process)).status, 200);
    assert.equal(await newCount(), 0);
    const stale = await active.inquiry({ ...process, operationId: randomUUID() });
    assert.equal(stale.status, 409);
    assert.ok(!stale.body.ok);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    const complete = {
      ...process,
      version: 2,
      operationId: randomUUID(),
      status: 'completed',
      note: 'Follow-up resolved offline; no order created',
    };
    const missingReason = await active.inquiry({ ...complete, note: undefined });
    assert.equal(missingReason.status, 409);
    assert.ok(!missingReason.body.ok);
    assert.equal(missingReason.body.error.code, 'REASON_REQUIRED');
    const completed = await active.inquiry(complete);
    assert.equal(completed.status, 200);

    // Remove every in-memory adapter/server reference used for requests. Log in
    // again through HTTP, then independently inspect disk rather than a UI cache.
    await closeServer(active.server);
    active = await start(new JsonFileAdapter(file));
    assert.deepEqual(await active.call(path, submit), saved);
    assert.deepEqual(await active.inquiry(complete), completed);
    const reloaded = await active.inquiry(get);
    assert.ok(reloaded.body.ok && reloaded.body.data.kind === 'detail');
    assert.equal(reloaded.body.data.item.status, 'completed');
    assert.equal(reloaded.body.data.item.version, 3);
    assert.equal(reloaded.body.data.item.events.length, 3);
    assert.equal(await newCount(), 0);
    const persisted = z
      .object({
        catalogQuoteRequests: z.array(
          z.object({
            _id: z.string(),
            status: z.string(),
            version: z.number(),
            notification: z.string(),
            events: z.array(z.object({ actorId: z.string() })),
            snapshot: z.object({ revision: z.string() }),
          }),
        ),
      })
      .parse(JSON.parse(readFileSync(file, 'utf8')));
    assert.equal(persisted.catalogQuoteRequests.length, 1);
    assert.equal(persisted.catalogQuoteRequests[0]?._id, id);
    assert.equal(persisted.catalogQuoteRequests[0]?.status, 'completed');
    assert.equal(persisted.catalogQuoteRequests[0]?.version, 3);
    assert.equal(persisted.catalogQuoteRequests[0]?.snapshot.revision, 'approved-revision');
    assert.equal(persisted.catalogQuoteRequests[0]?.notification, 'disabled-local');
    assert.deepEqual(
      persisted.catalogQuoteRequests[0]?.events.map((event) => event.actorId),
      Array(3).fill(active.actorId),
    );
  });
}
