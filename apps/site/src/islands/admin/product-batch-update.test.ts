import assert from 'node:assert/strict';
import test from 'node:test';
import { batchUpdateRecords, updateRecord } from './api.ts';

for (const sourceImageCount of [1, 19]) {
  test(`saving an existing publication does not auto-import ${sourceImageCount} newly synchronized description images`, async (t) => {
    const current = {
      _id: 'already-public',
      published: true,
      productFamily: 'headphones',
      imageIds: ['approved-gallery'],
      alibabaPrimarySourceKey: 'a'.repeat(64),
      alibabaDescriptionImageUrls: Array.from(
        { length: sourceImageCount },
        (_, index) => `https://s.alicdn.com/unreviewed-description-${index}.png`,
      ),
    };
    let prepared = false;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.action === 'get') return Response.json({ ok: true, data: current });
      if (body.action === 'catalogDetailCapabilities')
        return Response.json({ ok: true, data: { enabled: true } });
      if (body.action === 'update') {
        assert.deepEqual(body.data.values, { productFamily: 'headphones' });
        return Response.json({ ok: true, data: current });
      }
      assert.equal(body.action, 'catalogDetailApproval', 'must not import unreviewed source media');
      prepared = true;
      // Stop at the real approval boundary; the formal browser test below
      // exercises successful persistence through the real handler and database.
      return Response.json(
        { ok: false, error: { code: 'CONFLICT', message: 'approval-boundary-probe' } },
        { status: 409 },
      );
    });
    await assert.rejects(
      updateRecord('products', current._id, { productFamily: 'headphones', published: true }),
      /approval-boundary-probe/,
    );
    assert.equal(prepared, true);
  });
}

for (const selectedImages of [undefined, [], ['reviewed-description']]) {
  test(`first publication with over-capacity source media respects the explicit selection ${JSON.stringify(selectedImages)}`, async (t) => {
    const current = {
      _id: 'new-draft',
      published: false,
      productFamily: 'headphones',
      imageIds: ['approved-gallery'],
      descriptionImageIds: selectedImages,
      alibabaPrimarySourceKey: 'a'.repeat(64),
      alibabaDescriptionImageUrls: Array.from(
        { length: 19 },
        (_, i) => `https://s.alicdn.com/detail-${i}.png`,
      ),
    };
    let prepared = false;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.action === 'get') return Response.json({ ok: true, data: current });
      if (body.action === 'catalogDetailCapabilities')
        return Response.json({ ok: true, data: { enabled: true } });
      assert.equal(
        body.action,
        'catalogDetailApproval',
        'explicit media selection must not be replaced',
      );
      prepared = true;
      return Response.json(
        { ok: false, error: { code: 'CONFLICT', message: 'approval-boundary-probe' } },
        { status: 409 },
      );
    });
    await assert.rejects(
      updateRecord('products', current._id, { published: true }),
      selectedImages === undefined ? /18 description images/ : /approval-boundary-probe/,
    );
    assert.equal(prepared, selectedImages !== undefined);
  });
}

test('selected products can be assigned a main category without a publication patch', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'get')
      return Response.json({
        ok: true,
        data: {
          _id: body.data.id,
          published: false,
        },
      });
    assert.equal(body.action, 'update');
    assert.deepEqual(body.data.values, { productFamily: 'misc' });
    return Response.json({
      ok: true,
      data: { _id: body.data.id, productFamily: 'misc', published: false },
    });
  });
  const result = await batchUpdateRecords('products', ['one', 'two'], { productFamily: 'misc' });
  assert.equal(result.updated, 2);
  assert.deepEqual(result.failures, []);
});

test('classifying an already-public source product goes through approval, never a silent stale snapshot', async (t) => {
  const actions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    actions.push(body.action);
    if (body.action === 'get')
      return Response.json({
        ok: true,
        data: {
          _id: 'public-source',
          published: true,
          alibabaPrimarySourceKey: 'a'.repeat(64),
        },
      });
    if (body.action === 'catalogDetailCapabilities')
      return Response.json({ ok: true, data: { enabled: true } });
    if (body.action === 'update')
      return Response.json({
        ok: true,
        data: {
          _id: 'public-source',
          published: true,
          productFamily: 'misc',
          imageIds: ['owned-image'],
          alibabaPrimarySourceKey: 'a'.repeat(64),
          alibabaDescriptionImageUrls: Array.from(
            { length: 19 },
            (_, i) => `https://s.alicdn.com/category-refresh-${i}.png`,
          ),
        },
      });
    // Refusing preparation must surface a failure rather than claim the category
    // was published. The previous immutable public detail remains available.
    return Response.json(
      { ok: false, error: { code: 'CONFLICT', message: 'Refresh source before approval.' } },
      { status: 409 },
    );
  });
  const result = await batchUpdateRecords('products', ['public-source'], { productFamily: 'misc' });
  assert.equal(result.updated, 0);
  assert.equal(result.failures[0]?.code, 'CONFLICT');
  assert.ok(actions.includes('catalogDetailApproval'));
});

test('category-only edits never republish a product withdrawn by another admin during the operation', async (t) => {
  let published = true;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'get') {
      const snapshot = { _id: 'source', published, alibabaPrimarySourceKey: 'a'.repeat(64) };
      // Another administrator withdraws it after this reader sees public state.
      published = false;
      return Response.json({ ok: true, data: snapshot });
    }
    if (body.action === 'catalogDetailCapabilities')
      return Response.json({ ok: true, data: { enabled: false } });
    assert.equal(body.action, 'update');
    if (typeof body.data.values.published === 'boolean') published = body.data.values.published;
    return Response.json({ ok: true, data: { _id: 'source', productFamily: 'misc', published } });
  });
  const result = await batchUpdateRecords('products', ['source'], { productFamily: 'misc' });
  assert.equal(result.updated, 1);
  assert.equal(result.items[0]?.published, false);
});

test('category batches reject unknown categories and mixed changes before network', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Must not send');
  });
  for (const values of [
    { productFamily: 'wired' },
    { productFamily: '' },
    { productFamily: 'toys', published: true },
  ]) {
    await assert.rejects(batchUpdateRecords('products', ['one'], values), /up to 20/);
  }
});

test('product batch publishes through individual updates and retains each business rejection', async (t) => {
  const requests: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'catalogDetailCapabilities')
      return Response.json({ ok: true, data: { enabled: false } });
    requests.push(body.data);
    if (body.action === 'batchUpdate') {
      return Response.json(
        {
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'Products must be updated individually.' },
        },
        { status: 400 },
      );
    }
    assert.equal(body.action, 'update');
    if (body.data.id === 'missing-family') {
      return Response.json(
        {
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'Product family is required to publish' },
        },
        { status: 400 },
      );
    }
    return Response.json({
      ok: true,
      data: { _id: body.data.id, published: body.data.values.published },
    });
  });
  const result = await batchUpdateRecords(
    'products',
    ['ready', 'missing-family', 'ready', 'also-ready'],
    { published: true },
  );
  assert.equal(result.updated, 2);
  assert.deepEqual(
    result.items.map((item) => item._id),
    ['ready', 'also-ready'],
  );
  assert.deepEqual(
    requests,
    ['ready', 'missing-family', 'also-ready'].map((id) => ({
      collection: 'products',
      id,
      values: { published: true },
    })),
  );
  assert.deepEqual(result.failures, [
    {
      id: 'missing-family',
      code: 'VALIDATION_ERROR',
      message: 'Product family is required to publish',
      outcome: 'rejected',
    },
  ]);
});

test('a lost response stops the product batch and reports uncertainty rather than falsely reporting failure', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    throw new TypeError('Failed to fetch');
  });
  const result = await batchUpdateRecords('products', ['first', 'second'], { published: false });
  assert.equal(calls, 1);
  assert.equal(result.updated, 0);
  assert.deepEqual(
    result.failures.map((row) => [row.id, row.outcome]),
    [
      ['first', 'unconfirmed'],
      ['second', 'not-attempted'],
    ],
  );
});

test('invalid or oversized product batches are rejected before sending any request', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    throw new Error('No network request is allowed');
  });
  for (const ids of [[], [''], Array.from({ length: 21 }, (_, index) => String(index))]) {
    await assert.rejects(batchUpdateRecords('products', ids, { published: true }), /up to 20/);
  }
  await assert.rejects(batchUpdateRecords('products', ['one'], { published: 'true' }), /up to 20/);
  await assert.rejects(
    batchUpdateRecords('products', ['one'], { published: true, imageIds: [] }),
    /up to 20/,
  );
  assert.equal(calls, 0);
});

test('authorization rejection stops the batch without attempting later products', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json(
      { ok: false, error: { code: 'UNAUTHORIZED', message: 'Session expired. Please sign in.' } },
      { status: 401 },
    );
  });
  const result = await batchUpdateRecords('products', ['one', 'two'], { published: true });
  assert.equal(calls, 1);
  assert.deepEqual(
    result.failures.map((row) => row.outcome),
    ['rejected', 'not-attempted'],
  );
});

test('a mismatched success response is unconfirmed, not counted as a successful write', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({ ok: true, data: { _id: 'different-product', published: true } });
  });
  const result = await batchUpdateRecords('products', ['one', 'two'], { published: true });
  assert.equal(calls, 1);
  assert.equal(result.updated, 0);
  assert.deepEqual(
    result.failures.map((row) => row.outcome),
    ['unconfirmed', 'not-attempted'],
  );
});

test('non-product collections keep the existing batch protocol', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.action, 'batchUpdate');
    assert.deepEqual(body.data, {
      collection: 'overstock',
      ids: ['one'],
      values: { published: false },
    });
    return Response.json({
      ok: true,
      data: { updated: 1, items: [{ _id: 'one', published: false }] },
    });
  });
  assert.equal((await batchUpdateRecords('overstock', ['one'], { published: false })).updated, 1);
});
