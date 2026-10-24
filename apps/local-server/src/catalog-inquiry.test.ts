import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonFileAdapter } from './json-adapter.ts';

const id = '12345678-1234-4123-8123-123456789abc';
function inquiryFixture() {
  return {
    _id: id,
    schemaVersion: 'catalog-quote-request-v1',
    keyHash: 'private',
    fingerprint: 'private',
    target: { intent: 'variant_quote', productId: 'p1', revision: 'r1', variantId: 'v1' },
    fields: {
      intent: 'variant_quote',
      quantity: '500',
      deliveryDate: '',
      customizationTypes: [],
      brief: '',
      contactName: 'Buyer',
      company: 'Test Co',
      email: 'buyer@example.test',
      country: 'HK',
    },
    snapshot: {
      productId: 'p1',
      revision: 'r1',
      productName: 'Submitted Headset',
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
  };
}
async function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-inquiry-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  const db = new JsonFileAdapter(file);
  await db.create('users', {
    _id: 'admin',
    role: 'admin',
    username: 'Local Admin',
    status: 'active',
  });
  await db.create('catalogQuoteRequests', inquiryFixture());
  return { db, file };
}
const update = (version: number, patch: Record<string, unknown>) => ({
  action: 'update',
  id,
  version,
  operationId: randomUUID(),
  ...patch,
});
test('completion is explicit, reasoned, persistent and distinct from closing; viewing and notes keep attention', async (t) => {
  const { db, file } = await setup(t);
  assert.equal((await db.manageCatalogInquiry('admin', update(0, { note: 'Approved' }))).ok, true);
  const viewed = await db.manageCatalogInquiry('admin', { action: 'get', id });
  assert.ok(viewed.ok && viewed.data.kind === 'detail');
  assert.equal(viewed.data.item.status, 'new');
  const pending = await db.manageCatalogInquiry('admin', { action: 'list' });
  assert.ok(pending.ok && pending.data.kind === 'list');
  assert.equal(pending.data.newCount, 1);
  assert.equal(
    (
      await db.manageCatalogInquiry(
        'admin',
        update(1, { status: 'completed', note: 'Skipped processing' }),
      )
    ).ok,
    false,
  );
  assert.equal(
    (await db.manageCatalogInquiry('admin', update(1, { status: 'in_progress' }))).ok,
    true,
  );
  assert.equal(
    (await db.manageCatalogInquiry('admin', update(2, { status: 'completed' }))).ok,
    false,
  );
  const complete = update(2, {
    status: 'completed',
    note: 'Buyer confirmed follow-up finished offline',
  });
  const saved = await db.manageCatalogInquiry('admin', complete);
  assert.equal(saved.ok, true);
  const reopenedAdapter = new JsonFileAdapter(file);
  assert.deepEqual(await reopenedAdapter.manageCatalogInquiry('admin', complete), saved);
  const result = await reopenedAdapter.manageCatalogInquiry('admin', { action: 'get', id });
  assert.ok(result.ok && result.data.kind === 'detail');
  assert.equal(result.data.item.status, 'completed');
  assert.equal(result.data.item.version, 3);
  assert.equal(result.data.item.events[2]?.to, 'completed');
  assert.equal(
    (
      await db.manageCatalogInquiry(
        'admin',
        update(3, { note: 'No silent edits to terminal state' }),
      )
    ).ok,
    false,
  );
  assert.equal(
    (await db.manageCatalogInquiry('admin', update(3, { status: 'in_progress' }))).ok,
    false,
  );
  assert.equal(
    (
      await db.manageCatalogInquiry(
        'admin',
        update(3, { status: 'in_progress', note: 'Buyer has a further question' }),
      )
    ).ok,
    true,
  );
});
test('admin can read legacy inquiry without processing it or leaking dedup hashes; snapshot survives product changes', async (t) => {
  const { db } = await setup(t);
  const result = await db.manageCatalogInquiry('admin', { action: 'get', id });
  assert.ok(result.ok && result.data.kind === 'detail');
  assert.equal(result.data.item.version, 0);
  assert.equal(result.data.item.status, 'new');
  assert.equal(result.data.item.snapshot.productName, 'Submitted Headset');
  assert.equal(result.data.currentProduct.state, 'missing');
  assert.doesNotMatch(JSON.stringify(result), /keyHash|fingerprint/);
  await db.create('products', { _id: 'p1', name: 'Changed', published: false });
  const again = await db.manageCatalogInquiry('admin', { action: 'get', id });
  assert.ok(again.ok && again.data.kind === 'detail');
  assert.equal(again.data.currentProduct.state, 'unavailable');
  assert.equal(again.data.item.snapshot.productName, 'Submitted Headset');
});
test('inquiry workflow validates transitions and reasons, appends actor audit, closes and reopens', async (t) => {
  const { db } = await setup(t);
  for (const command of [
    update(0, { status: 'waiting_customer' }),
    update(0, { status: 'closed' }),
    update(0, { note: '' }),
    update(0, { status: 'new' }),
    update(0, { status: 'in_progress', actorId: 'fake' }),
  ]) {
    assert.equal((await db.manageCatalogInquiry('admin', command)).ok, false);
  }
  assert.equal(
    (
      await db.manageCatalogInquiry(
        'admin',
        update(0, { status: 'in_progress', note: 'Contacted buyer' }),
      )
    ).ok,
    true,
  );
  assert.equal(
    (await db.manageCatalogInquiry('admin', update(1, { status: 'waiting_customer' }))).ok,
    true,
  );
  assert.equal(
    (
      await db.manageCatalogInquiry(
        'admin',
        update(2, { status: 'closed', note: 'Buyer postponed project' }),
      )
    ).ok,
    true,
  );
  assert.equal(
    (await db.manageCatalogInquiry('admin', update(3, { note: 'Cannot modify a closed inquiry' })))
      .ok,
    false,
  );
  assert.equal(
    (
      await db.manageCatalogInquiry(
        'admin',
        update(3, { status: 'in_progress', note: 'Buyer resumed discussion' }),
      )
    ).ok,
    true,
  );
  const result = await db.manageCatalogInquiry('admin', { action: 'get', id });
  assert.ok(result.ok && result.data.kind === 'detail');
  assert.equal(result.data.item.version, 4);
  assert.equal(result.data.item.events.length, 4);
  assert.equal(result.data.item.events[0]?.actorName, 'Local Admin');
  assert.equal(result.data.item.events[0]?.note, 'Contacted buyer');
});
test('concurrent processing fails stale version, accepted retries survive restart without duplicate notes', async (t) => {
  const { db, file } = await setup(t);
  const command = update(0, { status: 'in_progress', note: 'Follow up' });
  const results = await Promise.all([
    db.manageCatalogInquiry('admin', command),
    db.manageCatalogInquiry('admin', update(0, { status: 'closed', note: 'Other admin' })),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results[1]?.ok, false);
  const reloaded = new JsonFileAdapter(file);
  assert.deepEqual(await reloaded.manageCatalogInquiry('admin', command), results[0]);
  assert.equal(
    (await reloaded.manageCatalogInquiry('admin', { ...command, note: 'Different' })).ok,
    false,
  );
  const row = JSON.parse(readFileSync(file, 'utf8')).catalogQuoteRequests[0];
  assert.equal(row.events.length, 1);
  assert.equal(row.fields.quantity, '500');
});
test('every inquiry read or mutation checks current admin role including suspend/delete and replay', async (t) => {
  const { db } = await setup(t);
  const command = update(0, { status: 'in_progress' });
  assert.equal((await db.manageCatalogInquiry('admin', command)).ok, true);
  for (const user of [
    { role: 'contributor' },
    { role: 'admin', status: 'suspended' },
    { role: 'unknown', status: 'active' },
  ]) {
    await db.update('users', 'admin', user);
    for (const input of [{ action: 'get', id }, { action: 'list' }, command]) {
      assert.deepEqual(await db.manageCatalogInquiry('admin', input), {
        ok: false,
        code: 'FORBIDDEN',
      });
    }
  }
  assert.equal((await db.manageCatalogInquiry('missing', { action: 'get', id })).ok, false);
});
test('list prioritizes new inquiries, paginates, filters and omits contacts; malformed records fail closed', async (t) => {
  const { db } = await setup(t);
  await db.create('catalogQuoteRequests', {
    ...inquiryFixture(),
    _id: randomUUID(),
    status: 'in_progress',
    createdAt: '2026-09-07T00:00:00.000Z',
  });
  const result = await db.manageCatalogInquiry('admin', { action: 'list', page: 1, pageSize: 1 });
  assert.ok(result.ok && result.data.kind === 'list');
  assert.equal(result.data.total, 2);
  assert.equal(result.data.newCount, 1);
  assert.equal(result.data.items[0]?.id, id);
  assert.doesNotMatch(JSON.stringify(result), /buyer@example|contactName|keyHash/);
  const filtered = await db.manageCatalogInquiry('admin', { action: 'list', status: 'closed' });
  assert.ok(filtered.ok && filtered.data.kind === 'list');
  assert.equal(filtered.data.total, 0);
  assert.equal(
    (await db.manageCatalogInquiry('admin', { action: 'list', pageSize: 1000 })).ok,
    false,
  );
  await db.update('catalogQuoteRequests', id, { fields: null });
  assert.deepEqual(await db.manageCatalogInquiry('admin', { action: 'get', id }), {
    ok: false,
    code: 'INVALID_RECORD',
  });
});
