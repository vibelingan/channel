import assert from 'node:assert/strict';
import test from 'node:test';
import { detailFixture } from '../../catalog/testing/detail-fixture.ts';
import { updateRecord } from './api.ts';
import {
  type DetailReview,
  approveDetailReview,
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
    if (body.action === 'update') {
      updates.push(body.data ?? {});
      current = { ...current, ...(body.data?.values as object), updatedAt: 'after-update' };
      data = current;
    }
    // As the server answers: begin stages the job (not complete); finish completes it.
    if (body.data?.action === 'begin') data = { ...progress, complete: false };
    if (body.data?.action === 'review')
      data = { ...review(1, 0), productId: 'canonical-product', previewMedia: undefined };
    return Response.json({ ok: true, data });
  });
  return { calls, updates };
}

test('publishing a manual product runs the approval, then publishes; no Alibaba imports', async (t) => {
  const api = manualApi(t, { productFamily: 'headphones', imageIds: ['img'], published: false });
  const saved = await updateRecord('products', 'canonical-product', { published: true });
  assert.equal(saved.published, true);
  assert.deepEqual(
    api.calls.filter((call) => call !== 'get' && call !== 'catalogDetailCapabilities'),
    ['approval:prepare', 'approval:review', 'approval:begin', 'approval:finish', 'update'],
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
  assert.ok(api.calls.includes('approval:finish'), api.calls.join(' → '));
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
