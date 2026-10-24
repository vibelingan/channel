import assert from 'node:assert/strict';
import test from 'node:test';
import { updateProductFromEditor, updateRecord } from './api.ts';

for (const response of ['missing-revision', 'wrong-id'] as const) {
  test(`manual publication stops before approval when draft save returns ${response}`, async (t) => {
    const later: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.action === 'catalogDetailCapabilities')
        return Response.json({ ok: true, data: { enabled: true } });
      if (body.action === 'get')
        return Response.json({
          ok: true,
          data: {
            _id: 'manual',
            published: false,
            productFamily: 'misc',
            imageIds: ['owned'],
            updatedAt: 'r1',
          },
        });
      if (body.action === 'update' && body.data.values.name)
        return Response.json({
          ok: true,
          data: {
            _id: response === 'wrong-id' ? 'other' : 'manual',
            productFamily: 'misc',
            imageIds: ['owned'],
            ...(response === 'wrong-id' ? { updatedAt: 'r2' } : {}),
          },
        });
      later.push(body.action);
      if (body.action === 'catalogDetailApproval')
        return Response.json({
          ok: true,
          data: { ok: true, status: 'approved', jobId: 'j', revision: 'approved-r' },
        });
      return Response.json({ ok: true, data: { _id: 'manual', published: true } });
    });
    await assert.rejects(
      updateRecord('products', 'manual', { name: 'Revised', published: true }, 'r1'),
      /revision|identity/i,
    );
    assert.deepEqual(later, [], 'an invalid save receipt must not start approval or publication');
  });
}

test('manual classification publication refuses an already-stale opening revision before approval', async (t) => {
  const writes: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'catalogDetailCapabilities')
      return Response.json({ ok: true, data: { enabled: true } });
    if (body.action === 'get')
      return Response.json({
        ok: true,
        data: {
          _id: 'manual',
          published: false,
          productFamily: 'misc',
          imageIds: ['owned'],
          updatedAt: 'newer',
        },
      });
    writes.push(body.action);
    if (body.action === 'catalogDetailApproval')
      return Response.json({
        ok: true,
        data: { ok: true, status: 'approved', jobId: 'j', revision: 'approved-r' },
      });
    return Response.json({ ok: true, data: { _id: 'manual', published: true } });
  });
  await assert.rejects(
    updateRecord('products', 'manual', { published: true }, 'older'),
    /changed|refresh/i,
  );
  assert.deepEqual(writes, []);
});

for (const linked of [false, true]) {
  for (const withdrawn of [false, true]) {
    test(`live refresh uses guarded non-publication intent (linked=${linked}, withdrawn=${withdrawn})`, async (t) => {
      let gets = 0;
      let published = true;
      let revision = 'r1';
      const writes: Record<string, unknown>[] = [];
      const snapshot = () => ({
        _id: 'live',
        name: 'Clock',
        published,
        productFamily: 'misc',
        imageIds: ['owned'],
        alibabaReviewPending: true,
        updatedAt: revision,
        ...(linked ? { alibabaPrimarySourceKey: 'a'.repeat(64) } : {}),
      });
      t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.action === 'catalogDetailCapabilities')
          return Response.json({ ok: true, data: { enabled: true } });
        if (body.action === 'get') {
          gets++;
          const data = snapshot();
          if (gets === 3 && withdrawn) {
            published = false;
            revision = 'withdrawn';
          }
          return Response.json({ ok: true, data });
        }
        if (body.action === 'catalogDetailApproval')
          return Response.json({
            ok: true,
            data: { ok: true, status: 'approved', jobId: 'job', revision: 'approved-r' },
          });
        assert.equal(body.action, 'update');
        writes.push(body.data);
        if (body.data.intent === 'refresh-live' && body.data.expectedUpdatedAt !== revision)
          return Response.json(
            {
              ok: false,
              error: {
                code: 'CONFLICT',
                message: 'Product changed. Keep your edits and check its current state.',
              },
            },
            { status: 409 },
          );
        if (typeof body.data.values.published === 'boolean') published = body.data.values.published;
        revision = 'r2';
        return Response.json({ ok: true, data: snapshot() });
      });
      if (withdrawn) {
        await assert.rejects(
          updateRecord('products', 'live', { productFamily: 'misc' }),
          /changed/i,
        );
        assert.equal(published, false);
      } else {
        await updateRecord('products', 'live', { productFamily: 'misc' });
        assert.deepEqual(writes.at(-1)?.values, {});
        assert.equal(writes.at(-1)?.intent, 'refresh-live');
        assert.equal(writes.at(-1)?.expectedUpdatedAt, 'r2');
      }
      assert.equal(
        writes.some((w) => Object.hasOwn(w.values as object, 'published')),
        false,
        'refresh never writes a publication toggle',
      );
    });
  }
}

for (const linked of [false, true]) {
  test(`editor live save never republishes after a withdrawal (linked=${linked})`, async (t) => {
    let published = true;
    let revision: string | null = 'opened';
    const writes: Record<string, unknown>[] = [];
    const current = () => ({
      _id: 'live-editor',
      name: 'Clock',
      productFamily: 'misc',
      imageIds: ['owned'],
      published,
      updatedAt: revision,
      alibabaReviewPending: true,
      alibabaReviewReason: 'edited',
      ...(linked ? { alibabaPrimarySourceKey: 'a'.repeat(64) } : {}),
    });
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.action === 'get') return Response.json({ ok: true, data: current() });
      if (body.action === 'catalogDetailCapabilities')
        return Response.json({ ok: true, data: { enabled: true } });
      if (body.action === 'catalogDetailApproval') {
        published = false;
        revision = 'withdrawn';
        return Response.json({
          ok: true,
          data: { ok: true, status: 'approved', jobId: 'j', revision: 'approved-r' },
        });
      }
      assert.equal(body.action, 'update');
      writes.push(body.data);
      if (Object.hasOwn(body.data.values, 'published')) published = body.data.values.published;
      revision = 'saved';
      return Response.json({ ok: true, data: current() });
    });
    await assert.rejects(
      updateProductFromEditor(
        { ...current(), updatedAt: 'opened' },
        { name: 'Edited clock', published: true },
      ),
      /withdrawn|archived/i,
    );
    assert.equal(published, false);
    assert.equal(
      writes.some((w) => Object.hasOwn(w.values as object, 'published')),
      false,
    );
  });
}

test('ordinary legacy editor save sends an explicit null revision instead of dropping the guard', async (t) => {
  let update: Record<string, unknown> | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'update') update = body.data;
    return Response.json({ ok: true, data: { _id: 'legacy', updatedAt: 'saved' } });
  });
  await updateProductFromEditor({ _id: 'legacy', published: false }, { name: 'Saved legacy' });
  assert.equal(Object.hasOwn(update ?? {}, 'expectedUpdatedAt'), true);
  assert.equal(update?.expectedUpdatedAt, null);
});
