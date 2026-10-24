import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  adminReadOnlyTransport,
  auditReadiness,
  createReadinessAudit,
  openReadinessAuditFile,
  summarizeReadinessAudit,
} from './catalog-readiness-audit.mjs';

const context = { apiOrigin: 'https://audit.example', actorId: 'admin-a' };
const rows = (count) =>
  Array.from({ length: count }, (_, i) => ({
    _id: `p-${String(i).padStart(4, '0')}`,
    name: `Product ${i}`,
    updatedAt: '2026-10-20T00:00:00.000Z',
    published: i % 3 === 0,
    productFamily: 'misc',
  }));
function reader(source, calls = []) {
  return async (action, data) => {
    calls.push({ action, data: structuredClone(data) });
    if (action === 'get') return structuredClone(source.find((row) => row._id === data.id));
    assert.equal(action, 'list');
    assert.equal(data.catalogReadiness, 'all');
    assert.equal(data.catalogListView, 'admin-product-list-v1');
    assert.deepEqual(data.sort, [{ field: '_id', dir: 'asc' }]);
    assert.equal(data.page, 1);
    const after = data.filter?.clauses[0].value ?? '';
    return {
      page: 1,
      pageSize: 100,
      // Deliberately stale total: only an empty tail ends a keyset pass.
      total: 1,
      catalogListView: data.catalogListView,
      items: source
        .filter((row) => row._id > after)
        .slice(0, 100)
        .map(({ _id }) => ({ _id, _adminProductListView: data.catalogListView })),
    };
  };
}

test('shadow audit reads every row twice through empty tails, preserves business data, and stores hashes', async () => {
  const source = rows(205);
  const before = JSON.stringify(source);
  const calls = [];
  const result = await auditReadiness(
    reader(source, calls),
    async () => {},
    createReadinessAudit(context),
    context,
  );
  assert.equal(result.phase, 'complete');
  assert.equal(result.rows.length, 205);
  assert.equal(result.verification.length, 205);
  assert.equal(calls.filter((call) => call.action === 'get').length, 410);
  assert.equal(calls.filter((call) => call.action === 'list').length, 8);
  assert.equal(JSON.stringify(source), before);
  assert.ok(!JSON.stringify(result).includes('Product '));
  assert.equal(summarizeReadinessAudit(result).total, 205);
  const empty = await auditReadiness(
    reader([]),
    async () => {},
    createReadinessAudit(context),
    context,
  );
  assert.equal(empty.phase, 'complete');
  assert.equal(summarizeReadinessAudit(empty).total, 0);
});

test('a failed get retains the last whole checkpoint and resumes without omitting rows', async () => {
  const source = rows(105);
  const base = reader(source);
  let saved = createReadinessAudit(context);
  await assert.rejects(
    auditReadiness(
      async (action, data) => {
        if (action === 'get' && data.id === 'p-0102') throw Error('response lost');
        return base(action, data);
      },
      async (value) => {
        saved = structuredClone(value);
      },
      saved,
      context,
    ),
    /response lost/,
  );
  assert.equal(saved.rows.length, 100);
  assert.equal(saved.rows.at(-1).productId, 'p-0099');
  const calls = [];
  const result = await auditReadiness(reader(source, calls), async () => {}, saved, context);
  assert.equal(calls[0].data.filter.clauses[0].value, 'p-0099');
  assert.equal(result.phase, 'complete');
  assert.equal(new Set(result.rows.map((row) => row.productId)).size, 105);
});

test('second-pass reconciliation detects insertions behind the cursor, deletions, and content changes', async () => {
  for (const mutate of [
    (source) => source.unshift({ ...source[0], _id: 'a-before-cursor' }),
    (source) => source.splice(1, 1),
    (source) => {
      source[1].name = 'Concurrent edit';
    },
  ]) {
    const source = rows(3);
    let changed = false;
    const result = await auditReadiness(
      reader(source),
      async (state) => {
        if (state.phase === 'reconciling' && !changed) {
          changed = true;
          mutate(source);
        }
      },
      createReadinessAudit(context),
      context,
    );
    assert.equal(result.phase, 'changed');
    assert.notEqual(result.rowsHash, result.verificationHash);
  }
});

test('wrong actor, endpoint, extra credential fields, and corrupted checkpoint hashes are refused before reads', async () => {
  for (const [state, binding] of [
    [createReadinessAudit(context), { ...context, actorId: 'other' }],
    [createReadinessAudit(context), { ...context, apiOrigin: 'https://other.example' }],
    [{ ...createReadinessAudit(context), token: 'never-save-token' }, context],
    [{ ...createReadinessAudit(context), rowsHash: 'a'.repeat(64) }, context],
  ]) {
    let calls = 0;
    await assert.rejects(
      auditReadiness(
        async () => {
          calls++;
        },
        async () => {},
        state,
        binding,
      ),
    );
    assert.equal(calls, 0);
  }
});

test('duplicate or unordered list identities, wrong DTOs, and mismatched full records cannot advance the checkpoint', async () => {
  for (const mode of ['duplicate', 'unordered', 'wrong-view', 'wrong-get']) {
    let saved = 0;
    const source = rows(3);
    const base = reader(source);
    await assert.rejects(
      auditReadiness(
        async (action, data) => {
          const value = await base(action, data);
          if (action === 'get') return mode === 'wrong-get' ? { ...value, _id: 'wrong' } : value;
          if (mode === 'duplicate') value.items[1] = value.items[0];
          if (mode === 'unordered') value.items.reverse();
          if (mode === 'wrong-view') value.catalogListView = 'old';
          return value;
        },
        async () => {
          saved++;
        },
        createReadinessAudit(context),
        context,
      ),
    );
    assert.equal(saved, 0);
  }
});

test('a malformed ready report is recorded as unchecked and exposes any scalar-query disagreement', async () => {
  const source = rows(1);
  source[0].published = false;
  source[0].catalogPreparationState = 'ready';
  source[0].catalogPreparationPolicy = 'catalog-preparation-v1';
  source[0].catalogPreparationReport = {
    schemaVersion: 'catalog-preparation-report-v2',
    productId: source[0]._id,
    contentGeneration: 0,
    policyVersion: 'catalog-preparation-v1',
    state: 'ready',
    previewReady: true,
    mediaReady: true,
    seal: {
      kind: 'catalog-preparation-ready-seal-v1',
      mediaPolicyVersion: 'catalog-protected-media-seal-v1',
      pixelPolicyVersion: 'catalog-pixels-v1',
    },
  };
  const result = await auditReadiness(
    reader(source),
    async () => {},
    createReadinessAudit(context),
    context,
  );
  assert.equal(result.rows[0].readiness, 'unchecked');
  assert.equal(result.rows[0].malformedReport, true);
  assert.equal(result.rows[0].projectionMismatch, true);
});

test('the audit recognizes existing legacy headphone classification without changing it', async () => {
  const source = [{ _id: 'p-0000', category: 'wired', published: false }];
  const before = JSON.stringify(source);
  const result = await auditReadiness(
    reader(source),
    async () => {},
    createReadinessAudit(context),
    context,
  );
  assert.equal(result.rows[0].classified, true);
  assert.equal(JSON.stringify(source), before);
});

test('private checkpoints resume atomically, reject symlinks and concurrent owners, and release their own lock', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'channel-readiness-audit-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'audit.json');
  const initial = createReadinessAudit(context);
  const first = await openReadinessAuditFile(file, 'audit', initial);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  try {
    await assert.rejects(openReadinessAuditFile(file, 'resume-audit'));
    await first.save(initial);
  } finally {
    await first.close();
  }
  const resumed = await openReadinessAuditFile(file, 'resume-audit');
  assert.deepEqual(resumed.manifest, initial);
  await resumed.close();
  const link = join(folder, 'link.json');
  await symlink(file, link);
  await assert.rejects(openReadinessAuditFile(link, 'resume-audit'));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), initial);
});

test('finished audits require a fresh file and failed concurrent reads drain before returning', async () => {
  const complete = await auditReadiness(
    reader([]),
    async () => {},
    createReadinessAudit(context),
    context,
  );
  await assert.rejects(
    auditReadiness(reader([]), async () => {}, complete, context),
    /new audit file/,
  );
  let active = 0;
  let maximum = 0;
  const base = reader(rows(12));
  await assert.rejects(
    auditReadiness(
      async (action, data) => {
        if (action !== 'get') return base(action, data);
        active++;
        maximum = Math.max(maximum, active);
        try {
          await setImmediate();
          if (data.id === 'p-0001') throw Error('read failed');
          return base(action, data);
        } finally {
          active--;
        }
      },
      async () => {},
      createReadinessAudit(context),
      context,
    ),
    /read failed/,
  );
  assert.ok(maximum > 1 && maximum <= 4);
  assert.equal(active, 0);
});

test('checkpoint save refuses externally changed files without overwriting them', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'channel-readiness-owner-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'audit.json');
  const initial = createReadinessAudit(context);
  const store = await openReadinessAuditFile(file, 'audit', initial);
  try {
    await writeFile(file, 'external owner edit');
    await assert.rejects(store.save(initial), /changed outside/);
    assert.equal(await readFile(file, 'utf8'), 'external owner edit');
  } finally {
    await store.close();
  }
});

test('authenticated audit HTTP refuses write actions and never forwards credentials through redirects', async (t) => {
  let received = 0;
  let forwarded = 0;
  const server = createServer((request, response) => {
    received++;
    if (request.url === '/forwarded') forwarded++;
    request.resume();
    response.writeHead(307, { location: '/forwarded' });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const call = adminReadOnlyTransport(`http://127.0.0.1:${address.port}`, 'synthetic-audit-token');
  await assert.rejects(call('create', { collection: 'products' }), /read-only/);
  await assert.rejects(call('get', { collection: 'users', id: 'other' }), /read-only/);
  assert.equal(received, 0);
  await assert.rejects(call('me'));
  assert.equal(received, 1);
  assert.equal(forwarded, 0);
});
