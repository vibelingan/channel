import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCurrentCatalogPreparation } from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { createCatalogPreparationAuthority } from '../../../../../packages/db/src/catalog-preparation-authority.ts';
import { setAdapter } from '../../../../../packages/db/src/index.ts';
import { setMediaStorage } from '../../../../../packages/media-storage/src/index.ts';
import { LocalDiskMediaStorage } from '../../../../../packages/media-storage/src/local-disk.ts';
import { runCatalogPreparationWorker } from '../../../../functions/admin/src/catalog-preparation-worker.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handleAdminFunctionEvent } from '../../../../functions/admin/src/http-adapter.ts';
import { fixture as sourceFixture } from '../../../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { importCandidateImage } from '../../../../functions/alibaba-catalog-sync/src/media-import.ts';
import { createLocalCatalogPreparationInvoker } from '../../../../local-server/src/catalog-preparation-invoker.ts';
import { JsonFileAdapter } from '../../../../local-server/src/json-adapter.ts';
import { runPreparation } from './catalog-preparation-api.ts';
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
  'base64',
);
function workspace(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-browser-preparation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  setMediaStorage(new LocalDiskMediaStorage(join(dir, 'media')));
  const h = sourceFixture(5);
  for (const [i, variant] of h.observation.variants.entries())
    variant.media = [
      { sourceUrl: `https://sc04.alicdn.com/browser-${i}.png`, role: 'variant', position: 0 },
    ];
  const observed = h.adapter.rows.catalogSourceObservations?.[0];
  assert.ok(observed);
  observed.observation = h.observation;
  h.adapter.rows.catalogSourceLinks = [];
  h.adapter.rows.images = [];
  const file = join(dir, 'db.json');
  writeFileSync(file, JSON.stringify(h.adapter.rows));
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const authority = createCatalogPreparationAuthority({
    secret: 'owned-browser-worker',
    environmentId: 'local-browser-worker',
  });
  return { adapter, authority, file, productId: h.product._id };
}
for (const lostResponse of [false, true]) {
  test(`browser controller crosses actual admin HTTP and source4+1 worker${lostResponse ? ' with lost final response recovery' : ''}`, async (t) => {
    const f = workspace(t);
    let imports = 0;
    const config = {
      jwtSecret: 'browser-local-session',
      enableDetailApproval: true,
      preparationAuthority: f.authority,
      preparationInvoke: createLocalCatalogPreparationInvoker((call) =>
        runCatalogPreparationWorker(f.authority, call, {
          importSourceImage: (url, persistImport) =>
            importCandidateImage(url, {
              persistImport,
              resolveDns: async () => ['104.16.1.1'],
              fetchImpl: async () => {
                imports++;
                return new Response(new Uint8Array(bytes));
              },
            }),
        }),
      ),
    };
    const token = await signSession(config.jwtSecret, {
      sub: 'admin',
      email: 'admin@example.test',
      name: 'Admin',
      role: 'admin',
    });
    const stored = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => token },
    });
    t.after(() => {
      if (stored) Object.defineProperty(globalThis, 'localStorage', stored);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    });
    const actions: string[] = [];
    let lost = false;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = z
        .object({ action: z.literal('catalogPreparation'), data: z.object({ action: z.string() }) })
        .parse(JSON.parse(String(init.body)));
      actions.push(body.data.action);
      const r = await handleAdminFunctionEvent(
        { httpMethod: 'POST', headers: {}, body: String(init.body) },
        config,
        handleAdminRequest,
      );
      if (lostResponse && !lost && body.data.action === 'continue' && imports === 5) {
        lost = true;
        throw Error('owned final HTTP response lost');
      }
      assert.ok('statusCode' in r);
      return new Response(r.body, {
        status: r.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    });
    const r = await runPreparation({ productId: f.productId });
    assert.equal(r.reason, 'ready', JSON.stringify(r));
    assert.ok(r.jobId);
    assert.equal(r.status?.report?.state, 'ready');
    assert.equal(imports, 5);
    assert.deepEqual(actions, [
      'start',
      'continue',
      'continue',
      ...(lostResponse ? ['status'] : []),
    ]);
    const p = await f.adapter.get('products', f.productId);
    assert.ok(p);
    assert.equal(p.published, false);
    assert.equal(p.productFamily, 'misc');
    assert.equal(readCurrentCatalogPreparation(p)?.state, 'ready');
    const disk = readFileSync(f.file, 'utf8');
    const resumed = await runPreparation({ productId: f.productId, jobId: r.jobId });
    assert.equal(resumed.reason, 'ready');
    assert.equal(actions.at(-1), 'status');
    assert.equal(imports, 5);
    assert.equal(readFileSync(f.file, 'utf8'), disk);
  });
}
