import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '../../../../../packages/shared/src/collections.ts';
import {
  type BatchUpdateResult,
  batchUpdateRecords,
  readbackProves,
  retryBatchUpdate,
  updateRecord,
} from './api.ts';

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
    let imported = 0;
    const saved: Record<string, unknown>[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.action === 'get') return Response.json({ ok: true, data: current });
      if (body.action === 'catalogDetailCapabilities')
        return Response.json({ ok: true, data: { enabled: true } });
      if (body.action === 'importSourceImage') {
        imported += 1;
        return Response.json({
          ok: true,
          data: { imageId: `owned-${imported}`, deduplicated: false },
        });
      }
      if (body.action === 'update') {
        saved.push(body.data.values);
        return Response.json({ ok: true, data: { ...current, ...body.data.values } });
      }
      assert.equal(body.action, 'catalogDetailApproval');
      prepared = true;
      return Response.json(
        { ok: false, error: { code: 'CONFLICT', message: 'approval-boundary-probe' } },
        { status: 409 },
      );
    });
    await assert.rejects(
      updateRecord('products', current._id, { published: true }),
      /approval-boundary-probe/,
    );
    assert.equal(prepared, true);
    if (selectedImages === undefined) {
      // Nothing chosen yet: the first 18 in Alibaba's order, as the Edit import takes.
      assert.equal(imported, 18);
      assert.deepEqual(saved, [
        { descriptionImageIds: Array.from({ length: 18 }, (_, i) => `owned-${i + 1}`) },
      ]);
    } else {
      // The admin's explicit selection is never replaced.
      assert.equal(imported, 0);
      assert.deepEqual(saved, []);
    }
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

test('product archive batches unpublish each product and confirm both fields', async (t) => {
  const ids: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.action, 'update');
    assert.deepEqual(body.data.values, { archived: true, published: false });
    ids.push(body.data.id);
    const product: CollectionDoc = {
      _id: body.data.id,
      productFamily: 'headphones',
      archived: true,
      published: false,
    };
    return Response.json({ ok: true, data: product });
  });
  const result = await batchUpdateRecords('products', ['one', 'two', 'one'], {
    archived: true,
    published: false,
  });
  assert.deepEqual(ids, ['one', 'two']);
  assert.equal(result.updated, 2);
  assert.deepEqual(result.failures, []);
});

test('category batches reject unknown categories and mixed changes before network', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Must not send');
  });
  for (const values of [
    { productFamily: 'wired' },
    { productFamily: '' },
    { productFamily: 'toys', published: true },
    { archived: true },
    { archived: true, published: true },
    { archived: false, published: false },
    { archived: true, published: false, imageIds: [] },
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
      retryable: false,
    },
  ]);
});

test('a server that stops answering stops the batch; unclear products are checked, still unclear', async (t) => {
  // Four run at once and all lose their answers. After the first one only one
  // result is unclear, so that worker starts a fifth product; the second
  // unclear result in a row stops the batch. The checks afterwards cannot
  // reach the server either, so those five stay unclear and say so.
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    throw new TypeError('Failed to fetch');
  });
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const result = await batchUpdateRecords('products', ids, { published: false });
  assert.equal(calls, 10, 'five updates, then five status checks');
  assert.equal(result.updated, 0);
  assert.deepEqual(
    result.failures.map((row) => [row.id, row.outcome, row.retryable]),
    [
      ['a', 'unconfirmed', true],
      ['b', 'unconfirmed', true],
      ['c', 'unconfirmed', true],
      ['d', 'unconfirmed', true],
      ['e', 'unconfirmed', true],
      ['f', 'not-attempted', true],
    ],
  );
  assert.match(String(result.failures[0]?.message), /^Couldn't check whether it went through/);
  assert.equal(
    result.failures[5]?.message,
    'Not tried because the server stopped answering. Try again in a minute.',
  );
});

test('one unclear result does not stop the batch; the product is checked afterwards', async (t) => {
  // The client's case: one product's answer is lost; the others must still run.
  let firstUpdate = true;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'update' && body.data.id === '0' && firstUpdate) {
      firstUpdate = false;
      throw new TypeError('Failed to fetch');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The lost update did go through: the status check finds it published.
    return Response.json({ ok: true, data: { _id: body.data.id, published: false } });
  });
  const result = await batchUpdateRecords('products', ['0', '1', '2', '3', '4', '5'], {
    published: false,
  });
  assert.deepEqual(
    result.items.map((item) => item._id),
    ['0', '1', '2', '3', '4', '5'],
    'checked, and counted as done',
  );
  assert.deepEqual(result.failures, []);
});

test('an unclear product that did not go through is reported plainly as retryable', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'update' && body.data.id === '0') throw new TypeError('Failed to fetch');
    return Response.json({
      ok: true,
      data: { _id: body.data.id, published: body.action === 'get' && body.data.id === '0' },
    });
  });
  const result = await batchUpdateRecords('products', ['0', '1'], { published: false });
  assert.deepEqual(
    result.items.map((item) => item._id),
    ['1'],
  );
  assert.deepEqual(result.failures, [
    {
      id: '0',
      code: 'NETWORK_ERROR',
      message: "Didn't go through: the server didn't answer in time. Try again.",
      outcome: 'rejected',
      retryable: true,
    },
  ]);
});

test('a BUSY answer is retried, and only reported when it keeps colliding', async (t) => {
  let updates = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    updates += 1;
    if (updates === 1)
      return Response.json(
        { ok: false, error: { code: 'BUSY', message: 'Nothing was saved; try again.' } },
        { status: 409 },
      );
    return Response.json({ ok: true, data: { _id: body.data.id, published: false } });
  });
  const result = await batchUpdateRecords('products', ['0'], { published: false });
  assert.equal(updates, 2, 'sent again after the collision');
  assert.deepEqual(result.failures, []);
});

test('a product that keeps colliding is reported once, as retryable', async (t) => {
  t.mock.method(Math, 'random', () => 0); // shortest pauses: 240 + 480 + 720 ms
  let updates = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    updates += 1;
    return Response.json(
      { ok: false, error: { code: 'BUSY', message: 'Nothing was saved; try again.' } },
      { status: 409 },
    );
  });
  const result = await batchUpdateRecords('products', ['0'], { published: false });
  assert.equal(updates, 4, 'the first try and three retries');
  assert.deepEqual(result.failures, [
    {
      id: '0',
      code: 'BUSY',
      message: 'Another change happened at the same moment. Try again.',
      outcome: 'rejected',
      retryable: true,
    },
  ]);
});

const earlier: BatchUpdateResult = {
  updated: 1,
  items: [{ _id: 'done', published: true }],
  failures: [
    { id: 'busy', code: 'BUSY', message: 'collided', outcome: 'rejected', retryable: true },
    {
      id: 'no-family',
      code: 'VALIDATION_ERROR',
      message: 'Choose a website category before publishing.',
      outcome: 'rejected',
      retryable: false,
    },
    {
      id: 'went-through',
      code: 'NETWORK_ERROR',
      message: "Couldn't check whether it went through.",
      outcome: 'unconfirmed',
      retryable: true,
    },
    {
      id: 'flagged',
      code: 'NOT_ATTEMPTED',
      message: 'Not tried because the server stopped answering.',
      outcome: 'not-attempted',
      retryable: true,
    },
    {
      id: 'unreadable',
      code: 'NOT_ATTEMPTED',
      message: 'Not tried because the server stopped answering.',
      outcome: 'not-attempted',
      retryable: true,
    },
  ],
};

test('trying again reads each product first and sends only what is still not done, with the revision just read', async (t) => {
  const current: Record<string, CollectionDoc> = {
    busy: { _id: 'busy', published: false, updatedAt: 'r-busy' },
    'went-through': { _id: 'went-through', published: true, updatedAt: 'r-went' },
    flagged: { _id: 'flagged', published: false, updatedAt: 'r-flagged' },
  };
  const updates: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'catalogDetailCapabilities')
      return Response.json({ ok: true, data: { enabled: false } });
    if (body.action === 'get') {
      const doc = current[body.data.id];
      if (!doc) throw new TypeError('Failed to fetch');
      return Response.json({ ok: true, data: doc });
    }
    assert.equal(body.action, 'update');
    updates.push(body.data);
    if (body.data.id === 'flagged')
      return Response.json(
        { ok: false, error: { code: 'CONFLICT', message: 'Changed since you looked.' } },
        { status: 409 },
      );
    return Response.json({ ok: true, data: { _id: body.data.id, published: true } });
  });
  const result = await retryBatchUpdate(
    earlier,
    ['busy', 'went-through', 'flagged', 'unreadable', 'no-family'],
    { published: true },
  );
  // Already published: counted, not sent again. Not retryable: never sent.
  // Unreadable: not sent without a revision.
  assert.deepEqual(updates, [
    {
      collection: 'products',
      id: 'busy',
      values: { published: true },
      expectedUpdatedAt: 'r-busy',
    },
    {
      collection: 'products',
      id: 'flagged',
      values: { published: true },
      expectedUpdatedAt: 'r-flagged',
    },
  ]);
  assert.deepEqual(
    result.items.map((item) => item._id),
    ['done', 'went-through', 'busy'],
  );
  assert.equal(result.updated, 3);
  assert.deepEqual(
    result.failures.map((row) => [row.id, row.outcome, row.retryable, row.message]),
    [
      ['no-family', 'rejected', false, 'Choose a website category before publishing.'],
      ['flagged', 'rejected', false, 'Changed since you looked.'],
      [
        'unreadable',
        'not-attempted',
        true,
        "Couldn't read the product to try again. Refresh the list, then try again.",
      ],
    ],
  );
});

test('trying again a change other than publishing sends it again as it is', async (t) => {
  const updates: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.action, 'update', 'no reads: disabling twice is harmless');
    updates.push(body.data);
    return Response.json({ ok: true, data: { _id: body.data.id, published: false } });
  });
  const result = await retryBatchUpdate(
    {
      updated: 0,
      items: [],
      failures: [
        { id: 'a', code: 'BUSY', message: 'collided', outcome: 'rejected', retryable: true },
      ],
    },
    ['a'],
    { published: false },
  );
  assert.deepEqual(updates, [{ collection: 'products', id: 'a', values: { published: false } }]);
  assert.deepEqual(result, { updated: 1, items: [{ _id: 'a', published: false }], failures: [] });
});

test('products run four at a time, and results keep the selection order', async (t) => {
  let running = 0;
  let peak = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    running += 1;
    peak = Math.max(peak, running);
    // Later products answer sooner, so completion order differs from selection order.
    await new Promise((resolve) => setTimeout(resolve, 20 - Number(body.data.id)));
    running -= 1;
    return Response.json({ ok: true, data: { _id: body.data.id, published: false } });
  });
  const ids = Array.from({ length: 10 }, (_, index) => String(index));
  const result = await batchUpdateRecords('products', ids, { published: false });
  assert.equal(peak, 4);
  assert.deepEqual(
    result.items.map((item) => item._id),
    ids,
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

test('authorization rejection starts no new product', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json(
      { ok: false, error: { code: 'UNAUTHORIZED', message: 'Session expired. Please sign in.' } },
      { status: 401 },
    );
  });
  const result = await batchUpdateRecords('products', ['1', '2', '3', '4', '5'], {
    published: false,
  });
  assert.equal(calls, 4);
  assert.deepEqual(
    result.failures.map((row) => row.outcome),
    ['rejected', 'rejected', 'rejected', 'rejected', 'not-attempted'],
  );
});

test('a mismatched success response is unconfirmed, not counted as a successful write', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({ ok: true, data: { _id: 'different-product', published: true } });
  });
  const result = await batchUpdateRecords('products', ['1', '2', '3', '4', '5'], {
    published: false,
  });
  // Every answer is about another product, so neither the update nor the
  // status check afterwards confirms anything: all five stay unclear.
  assert.equal(calls, 10);
  assert.equal(result.updated, 0);
  assert.deepEqual(
    result.failures.map((row) => row.outcome),
    ['unconfirmed', 'unconfirmed', 'unconfirmed', 'unconfirmed', 'unconfirmed'],
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

test('a read-back proves a change only when no approval is left unproven (DEC-21)', () => {
  const publish = { published: true };
  assert.equal(readbackProves({ _id: 'a', published: false }, publish), 'not-done');
  assert.equal(readbackProves({ _id: 'a', published: true }, publish), 'done');
  // Live but still waiting for review: its re-approval may not have run.
  assert.equal(
    readbackProves({ _id: 'a', published: true, alibabaReviewPending: true }, publish),
    'unproven',
  );
  const category = { productFamily: 'toys' };
  assert.equal(readbackProves({ _id: 'a', productFamily: 'toys' }, category), 'done');
  // A live product's new category is approved too; the field alone is no proof.
  assert.equal(
    readbackProves({ _id: 'a', productFamily: 'toys', published: true }, category),
    'unproven',
  );
  assert.equal(readbackProves({ _id: 'a', published: true }, { published: false }), 'not-done');
});

test('a lost answer on a live product still waiting for review is not reported as published', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'catalogDetailCapabilities')
      return Response.json({ ok: true, data: { enabled: false } });
    if (body.action === 'update') throw new TypeError('Failed to fetch');
    return Response.json({
      ok: true,
      data: { _id: body.data.id, published: true, alibabaReviewPending: true },
    });
  });
  const result = await batchUpdateRecords('products', ['edited'], { published: true });
  assert.equal(result.updated, 0);
  assert.deepEqual(
    result.failures.map((row) => [row.outcome, row.retryable, row.message]),
    [['unconfirmed', true, "Couldn't confirm the website shows this change. Try again."]],
  );
});

test('trying again re-sends a live product still waiting for review instead of counting it', async (t) => {
  const updates: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'catalogDetailCapabilities')
      return Response.json({ ok: true, data: { enabled: false } });
    if (body.action === 'get')
      return Response.json({
        ok: true,
        data: { _id: 'edited', published: true, alibabaReviewPending: true, updatedAt: 'r1' },
      });
    updates.push(body.data);
    return Response.json({ ok: true, data: { _id: 'edited', published: true } });
  });
  const result = await retryBatchUpdate(
    {
      updated: 0,
      items: [],
      failures: [
        { id: 'edited', code: 'BUSY', message: 'x', outcome: 'rejected', retryable: true },
      ],
    },
    ['edited'],
    { published: true },
  );
  assert.deepEqual(updates, [
    { collection: 'products', id: 'edited', values: { published: true }, expectedUpdatedAt: 'r1' },
  ]);
  assert.equal(result.updated, 1);
});

test('one unclear result between successes never stops the batch', async (t) => {
  // Unclear, fine, unclear: never two unclear in a row, so every product runs.
  let updates = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'update') {
      updates += 1;
      if (body.data.id === 'a' || body.data.id === 'c') throw new TypeError('Failed to fetch');
    }
    await new Promise((resolve) => setTimeout(resolve, body.data.id === 'b' ? 1 : 5));
    return Response.json({ ok: true, data: { _id: body.data.id, published: false } });
  });
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const result = await batchUpdateRecords('products', ids, { published: false });
  assert.equal(updates, 5, 'all five were sent');
  assert.equal(result.failures.filter((row) => row.outcome === 'not-attempted').length, 0);
});

test('a status check answered about another product with matching values proves nothing', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === 'update') throw new TypeError('Failed to fetch');
    return Response.json({ ok: true, data: { _id: 'different-product', published: false } });
  });
  const result = await batchUpdateRecords('products', ['a'], { published: false });
  assert.equal(result.updated, 0);
  assert.equal(result.failures[0]?.outcome, 'unconfirmed');
});

test('after a refused sign-in, untried products offer no Try again', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json(
      { ok: false, error: { code: 'UNAUTHORIZED', message: 'Sign in again' } },
      { status: 401 },
    );
  });
  const result = await batchUpdateRecords('products', ['a', 'b', 'c', 'd', 'e', 'f'], {
    published: false,
  });
  const untried = result.failures.filter((row) => row.outcome === 'not-attempted');
  assert.ok(untried.length > 0);
  assert.ok(untried.every((row) => row.retryable === false));
  assert.ok(calls <= 4);
});
