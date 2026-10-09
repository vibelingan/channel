import assert from 'node:assert/strict';
import test from 'node:test';
import { detailFixture } from '../../catalog/testing/detail-fixture.ts';
import { DraftSavedError, createRecord, updateRecord } from './api.ts';
import {
  type DetailReview,
  approveDetailReview,
  approveProduct,
  prepareDetailReview,
} from './catalog-detail-approval-api.ts';

function review(page = 1, total = 3): DetailReview {
  return {
    ok: true,
    kind: 'review',
    productId: 'canonical-product',
    expectedDigest: 'a'.repeat(64),
    expectedRevision: null,
    detail: detailFixture(total, page),
    previewMedia: {
      galleryIds: [],
      descriptionIds: [],
      gallerySources: [],
      descriptionSources: [],
      importDigest: 'b'.repeat(64),
      variantSources: [
        {
          id: `variant-${page}`,
          sources: ['https://sc04.alicdn.com/black.jpg'],
          unboundSources: ['https://sc04.alicdn.com/black.jpg'],
        },
      ],
    },
  };
}
const progress = {
  ok: true,
  jobId: 'job',
  revision: 'revision',
  nextPage: 0,
  pages: 0,
  complete: true,
};
type RequestBody = {
  action: string;
  data: {
    action?: string;
    page?: number;
    expectedDigest?: string;
    url?: string;
    command?: { expectedDigest: string };
  };
};

test('Preview never imports; explicit approval imports each reviewed URL once then uses the rebound digest', async (t) => {
  const calls: RequestBody[] = [];
  let imported = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body: RequestBody = JSON.parse(String(init.body));
    calls.push(body);
    let data: unknown = progress;
    if (body.action === 'importSourceImage') {
      imported = true;
      data = { imageId: 'owned', deduplicated: false };
    }
    if (body.data.action === 'review') {
      const item = review();
      if (imported) {
        item.expectedDigest = 'c'.repeat(64);
        if (item.previewMedia) item.previewMedia.variantSources = [];
      } else if (item.previewMedia)
        item.previewMedia.variantSources?.push(...(item.previewMedia.variantSources ?? []));
      data = item;
    }
    return Response.json({ ok: true, data });
  });
  const draft = await prepareDetailReview('canonical-product');
  assert.equal(
    calls.some((c) => c.action === 'importSourceImage'),
    false,
  );
  await approveDetailReview(draft, '12345678-1234-4234-8234-123456789012');
  assert.equal(calls.filter((c) => c.action === 'importSourceImage').length, 1);
  assert.equal(
    calls.find((c) => c.data.action === 'begin')?.data.command?.expectedDigest,
    'c'.repeat(64),
  );
});

test('approval includes unmapped photos from later pages without inventing a page or using a stale digest', async (t) => {
  const first = review(1, 51);
  if (first.previewMedia) first.previewMedia.variantSources = [];
  const calls: RequestBody[] = [];
  let imported = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body: RequestBody = JSON.parse(String(init.body));
    calls.push(body);
    let data: unknown = progress;
    if (body.action === 'importSourceImage') {
      imported = true;
      data = { imageId: 'owned', deduplicated: true };
    }
    if (body.data.action === 'review') {
      const item = review(body.data.page ?? 1, 51);
      if (imported && item.previewMedia) item.previewMedia.variantSources = [];
      data = item;
    }
    return Response.json({ ok: true, data });
  });
  await approveDetailReview(first, '12345678-1234-4234-8234-123456789012');
  assert.equal(calls.find((c) => c.data.page === 2)?.data.expectedDigest, first.expectedDigest);
  assert.equal(calls.filter((c) => c.action === 'importSourceImage').length, 1);
});

test('failed import, concurrent edit and abort never begin approval', async (t) => {
  for (const scenario of ['failure', 'changed', 'abort']) {
    const calls: RequestBody[] = [];
    const controller = new AbortController();
    const mock = t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body: RequestBody = JSON.parse(String(init.body));
      calls.push(body);
      if (body.action === 'importSourceImage') {
        if (scenario === 'failure') throw new Error('image download failed');
        return Response.json({ ok: true, data: { imageId: 'owned', deduplicated: true } });
      }
      const item = review();
      if (item.previewMedia) item.previewMedia.importDigest = 'd'.repeat(64);
      return Response.json({ ok: true, data: body.data.action === 'review' ? item : progress });
    });
    if (scenario === 'abort') controller.abort();
    await assert.rejects(
      approveDetailReview(review(), '12345678-1234-4234-8234-123456789012', controller.signal),
    );
    assert.equal(
      calls.some((c) => c.data.action === 'begin'),
      false,
      scenario,
    );
    mock.mock.restore();
  }
});

// --- MIU-32: manual products publish through the same approval ---------------

type AdminCall = { action: string; data?: Record<string, unknown> };
function manualApi(
  t: { mock: { method: typeof test.mock.method } },
  product: Record<string, unknown>,
) {
  const calls: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = {
    _id: 'canonical-product',
    name: 'Kids headset',
    ...product,
  };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body: AdminCall = JSON.parse(String(init.body));
    const step =
      body.action === 'catalogDetailApproval' ? `approval:${body.data?.action}` : body.action;
    calls.push(step);
    let data: unknown = progress;
    if (body.action === 'catalogDetailCapabilities') data = { enabled: true };
    if (body.action === 'get') data = current;
    if (body.action === 'create') {
      creates.push(body.data ?? {});
      current = { _id: 'canonical-product', ...(body.data?.values as object) };
      data = current;
    }
    if (body.action === 'update') {
      updates.push(body.data ?? {});
      current = { ...current, ...(body.data?.values as object), updatedAt: 'after-update' };
      data = current;
    }
    // As the server answers: begin stages the job (not complete); finish completes it.
    if (body.data?.action === 'begin') data = { ...progress, complete: false };
    if (body.data?.action === 'approve')
      data = { ok: true, status: 'approved', jobId: 'job', revision: 'revision' };
    if (body.data?.action === 'review')
      data = { ...review(1, 0), productId: 'canonical-product', previewMedia: undefined };
    return Response.json({ ok: true, data });
  });
  return { calls, updates, creates };
}

test('publishing a manual product runs the approval, then publishes; no Alibaba imports', async (t) => {
  const api = manualApi(t, { productFamily: 'headphones', imageIds: ['img'], published: false });
  const saved = await updateRecord('products', 'canonical-product', { published: true });
  assert.equal(saved.published, true);
  assert.deepEqual(
    api.calls.filter((call) => call !== 'get' && call !== 'catalogDetailCapabilities'),
    // One request runs the whole approval (publish speed), then the publication.
    ['approval:approve', 'update'],
  );
  assert.equal(api.calls.includes('importSourceImage'), false);
  assert.deepEqual(api.updates.at(-1)?.values, { published: true });
});

test('a manual product without photos stops before any approval call', async (t) => {
  const api = manualApi(t, { productFamily: 'headphones', imageIds: [], published: false });
  await assert.rejects(
    updateRecord('products', 'canonical-product', { published: true }),
    /Add at least one product image before publishing/,
  );
  assert.equal(
    api.calls.some((call) => call.startsWith('approval:')),
    false,
  );
});

test('a category-only save on a published manual product refreshes its approved version', async (t) => {
  const api = manualApi(t, { productFamily: 'headphones', imageIds: ['img'], published: true });
  await updateRecord('products', 'canonical-product', { productFamily: 'toys' });
  assert.ok(api.calls.includes('approval:approve'), api.calls.join(' → '));
  assert.deepEqual(api.updates[0]?.values, { productFamily: 'toys' });
  assert.equal(api.updates.length, 1, 'publication state is not touched');
});

test('a guarded batch publish of a manual product keeps its revision guard through approval', async (t) => {
  const api = manualApi(t, {
    productFamily: 'headphones',
    imageIds: ['img'],
    published: false,
    updatedAt: 'seen',
  });
  await updateRecord('products', 'canonical-product', { published: true }, 'seen');
  assert.deepEqual(api.updates.at(-1), {
    collection: 'products',
    id: 'canonical-product',
    values: { published: true },
    expectedUpdatedAt: 'seen',
  });
});

test('a category change on a published manual product without an image is refused before any write', async (t) => {
  const api = manualApi(t, { productFamily: 'headphones', imageIds: [], published: true });
  await assert.rejects(
    updateRecord('products', 'canonical-product', { productFamily: 'toys' }),
    /Add at least one product image before publishing/,
  );
  assert.deepEqual(api.updates, [], 'nothing saved, so "needs attention" is exact');
});

// --- DEC-18 (revised 2026-10-08): approval never takes supplier text or photos silently.
// The admin chooses them in Supplier changes (DEC-19); approval publishes the
// product's own text and photos.

/** A live Alibaba-linked product behind the real admin API protocol. */
function linkedApi(t: { mock: { method: typeof test.mock.method } }) {
  const calls: string[] = [];
  const updates: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = {
    _id: 'canonical-product',
    name: 'Headset',
    description: 'Old text',
    imageIds: ['img-a', 'img-b'],
    productFamily: 'headphones',
    published: true,
    alibabaPrimarySourceKey: 'source-a',
    catalogDetailPublication: { state: 'approved', revision: 'r1' },
  };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body: AdminCall = JSON.parse(String(init.body));
    calls.push(
      body.action === 'catalogDetailApproval' ? `approval:${body.data?.action}` : body.action,
    );
    let data: unknown = progress;
    if (body.action === 'catalogDetailCapabilities') data = { enabled: true };
    if (body.action === 'get') data = current;
    if (body.action === 'update') {
      updates.push(body.data ?? {});
      current = { ...current, ...(body.data?.values as object), updatedAt: 'after-update' };
      data = current;
    }
    if (body.data?.action === 'begin') data = { ...progress, complete: false };
    if (body.data?.action === 'approve')
      data = { ok: true, status: 'approved', jobId: 'job', revision: 'revision' };
    if (body.data?.action === 'review')
      data = { ...review(1, 0), productId: 'canonical-product', previewMedia: undefined };
    return Response.json({ ok: true, data });
  });
  return { calls, updates };
}

test('approving a live linked product never asks to take the supplier text or photos', async (t) => {
  const api = linkedApi(t);
  await updateRecord('products', 'canonical-product', { published: true });
  assert.equal(api.calls.includes('approval:supplier-adoption'), false);
  assert.equal(api.calls.includes('importSourceImage'), false);
  assert.ok(api.calls.includes('approval:approve'));
  assert.deepEqual(
    api.updates.map((update) => update.values),
    [{ published: true }],
    'only the publication changes; description and photos stay the product’s own',
  );
});

// --- Publish speed (2026-10-08): one request per approval, step-by-step only as fallback.

test('when the server hands back, the step-by-step approval resumes the same operation', async (t) => {
  const steps: string[] = [];
  const operations = new Set<unknown>();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body: AdminCall & {
      data?: { operationId?: unknown; command?: { operationId?: unknown } };
    } = JSON.parse(String(init.body));
    steps.push(String(body.data?.action ?? body.action));
    let data: unknown = progress;
    if (body.data?.action === 'approve') {
      operations.add(body.data.operationId);
      data = { ok: true, status: 'needs-browser', reason: 'media-import' };
    }
    if (body.data?.action === 'review')
      data = { ...review(1, 0), productId: 'canonical-product', previewMedia: undefined };
    if (body.data?.action === 'begin') {
      operations.add(body.data.command?.operationId);
      data = { ...progress, complete: false };
    }
    return Response.json({ ok: true, data });
  });
  await approveProduct('canonical-product');
  assert.deepEqual(steps, ['approve', 'prepare', 'review', 'begin', 'finish']);
  assert.equal(operations.size, 1, 'begin resumes the job the server started');
});

test('an approved answer ends the approval in one request', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return Response.json({
      ok: true,
      data: { ok: true, status: 'approved', jobId: 'job', revision: 'revision' },
    });
  });
  await approveProduct('canonical-product');
  assert.equal(requests, 1);
});

// --- MIU-37: a new product starts as a draft; OWN-1: contributors save without the admin-only approval ---

test('creating a product as Published saves a draft, then approves and publishes it', async (t) => {
  const api = manualApi(t, {});
  const saved = await createRecord('products', {
    name: 'Kids headset',
    productFamily: 'headphones',
    imageIds: ['img'],
    published: true,
  });
  assert.equal(saved.published, true);
  assert.equal(api.creates[0]?.values && Reflect.get(api.creates[0].values, 'published'), false);
  assert.deepEqual(
    api.calls.filter((call) => call !== 'get' && call !== 'catalogDetailCapabilities'),
    ['create', 'approval:approve', 'update'],
  );
});

test('when publishing the new product fails, the draft is kept and the error says so', async (t) => {
  manualApi(t, {});
  const failure = await createRecord('products', {
    name: 'Kids headset',
    productFamily: 'headphones',
    imageIds: [],
    published: true,
  }).catch((error: unknown) => error);
  assert.ok(failure instanceof DraftSavedError);
  assert.equal(failure.draft._id, 'canonical-product');
  assert.match(failure.message, /Saved as a draft/);
  assert.match(failure.message, /Add at least one product image before publishing/);
});

test('a draft is created in one request', async (t) => {
  const api = manualApi(t, {});
  await createRecord('products', { name: 'Kids headset', published: false });
  assert.deepEqual(api.calls, ['create']);
});

test('a contributor save goes straight to the server, which keeps it as a draft for an admin', async (t) => {
  const calls: AdminCall[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body: AdminCall = JSON.parse(String(init.body));
    calls.push(body);
    if (body.action === 'catalogDetailCapabilities')
      return Response.json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Admin permission is required.' },
      });
    return Response.json({ ok: true, data: { _id: 'p1', ...(body.data?.values as object) } });
  });
  const values = { name: 'Renamed', productFamily: 'headphones', published: true };
  await updateRecord('products', 'p1', values);
  assert.deepEqual(
    calls.map((call) => call.action),
    ['catalogDetailCapabilities', 'update'],
  );
  assert.deepEqual(calls.at(-1)?.data?.values, values);
});
