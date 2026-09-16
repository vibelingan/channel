/**
 * Deterministic tests for the corpus swap.
 *
 * Every prior claim about this algorithm — rollback works, migration works,
 * repeated runs are idempotent — rested on a manual run against a live engine.
 * A live run proves what happened once; it cannot prove what happens when the
 * upload fails, when only the old generation retrieves, or when a document
 * silently fails to attach. Those are exactly the cases that cost the corpus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOCUMENT_NAMESPACE, isOwned, refreshCorpus } from './ai-corpus-refresh.mjs';

const LEGACY = ['key-facts-home', 'en-US-home', 'en-US-headphones'];

const DOCUMENTS = [
  { name: 'key-facts-home', text: 'MOQ from 500 units', docSource: '/', description: 'Key facts' },
  { name: 'en-us-headphones', text: 'Headphones', docSource: '/headphones', description: 'Phones' },
];

/**
 * An in-memory engine. `faults` makes any single step fail the way a real one
 * does, which is the only way to test what happens next.
 */
function fakeClient({ attached = [], faults = {}, searchFrom = 'new', generation = 1000 } = {}) {
  const storage = new Set(attached);
  const workspace = new Set(attached);
  const calls = { upload: 0, attach: 0, detach: 0, destroy: 0, search: 0 };
  let counter = 0;

  return {
    calls,
    get attached() {
      return [...workspace];
    },
    get storage() {
      return [...storage];
    },
    async listAttached() {
      return [...workspace];
    },
    async upload(document) {
      calls.upload += 1;
      if (faults.upload && calls.upload >= faults.upload) throw new Error('upload failed');
      const path = `custom-documents/raw-${document.title.toLowerCase()}-${++counter}.json`;
      storage.add(path);
      return path;
    },
    async attach(paths) {
      calls.attach += 1;
      if (faults.attach) throw new Error('attach failed');
      // `partialAttach` drops one, the way an engine that accepts the call and
      // then fails on one document does.
      const landing = faults.partialAttach ? paths.slice(0, -1) : paths;
      for (const path of landing) workspace.add(path);
    },
    async detach(paths) {
      calls.detach += 1;
      if (faults.detach) throw new Error('detach failed');
      for (const path of paths) workspace.delete(path);
    },
    async destroy(paths) {
      calls.destroy += 1;
      if (faults.destroy) throw new Error('destroy failed');
      for (const path of paths) storage.delete(path);
    },
    async search() {
      calls.search += 1;
      if (faults.search) throw new Error('search failed');
      if (searchFrom === 'none') return [];
      // A real search returns whatever is attached and matches; it does not
      // know about generations. `searchFrom: 'old'` models the case that
      // matters — the new documents attached but retrieve nothing, so only the
      // previous generation comes back.
      const pool = [...workspace];
      const current = `${DOCUMENT_NAMESPACE}-g${generation}-`;
      const chosen = searchFrom === 'old' ? pool.filter((path) => !path.includes(current)) : pool;
      return chosen.map((path) => ({ source: path }));
    },
  };
}

const run = (client, extra = {}) =>
  refreshCorpus({
    client,
    documents: DOCUMENTS,
    legacyNames: LEGACY,
    verifyQuery: 'minimum order quantity',
    generation: 1000,
    ...extra,
  });

test('a clean run uploads, attaches, verifies, and leaves only the new generation', async () => {
  const client = fakeClient();
  const result = await run(client);
  assert.equal(result.uploaded.length, 2);
  assert.equal(client.attached.length, 2);
  for (const path of client.attached) assert.match(path, /channelkb-g1000-/);
});

test('an old generation is replaced, not accumulated', async () => {
  const client = fakeClient({
    attached: ['custom-documents/raw-channelkb-g900-key-facts-home-1.json'],
  });
  await run(client);
  assert.equal(client.attached.length, 2, 'the old generation was left attached');
  assert.ok(!client.attached.some((path) => path.includes('g900')));
});

test('pre-namespace documents are migrated rather than left duplicating the corpus', async () => {
  // The observed failure: twelve documents where six belonged, and the
  // duplication pushed a fact out of retrieval.
  const client = fakeClient({
    attached: [
      'custom-documents/raw-key-facts-home-aaa.json',
      'custom-documents/raw-en-us-home-bbb.json',
    ],
  });
  await run(client);
  assert.equal(client.attached.length, 2);
  assert.ok(!client.attached.some((path) => path.includes('raw-key-facts-home-aaa')));
});

test('documents this script does not own are never deleted', async () => {
  const foreign = 'custom-documents/raw-somebody-elses-upload-zzz.json';
  const client = fakeClient({ attached: [foreign] });
  const result = await run(client);
  assert.deepEqual(result.foreign, [foreign]);
  assert.ok(client.attached.includes(foreign), 'a hand-attached document was deleted');
});

test('THE CASE THAT MATTERED: retrieval from the old generation only does not approve the new one', async () => {
  // Reproduces Round 9's mock exactly. The old corpus is the only thing that
  // retrieves; approving on that evidence would delete it.
  const old = 'custom-documents/raw-channelkb-g900-key-facts-home-1.json';
  const client = fakeClient({ attached: [old], searchFrom: 'old' });
  await assert.rejects(run(client), /none from generation g1000/);
  assert.ok(client.attached.includes(old), 'the only retrievable corpus was deleted');
});

test('retrieval returning nothing at all rolls back', async () => {
  const old = 'custom-documents/raw-channelkb-g900-key-facts-home-1.json';
  const client = fakeClient({ attached: [old], searchFrom: 'none' });
  await assert.rejects(run(client), /retrieved nothing/);
  assert.deepEqual(client.attached, [old]);
});

test('a partial attach is caught and rolled back', async () => {
  const old = 'custom-documents/raw-channelkb-g900-key-facts-home-1.json';
  const client = fakeClient({ attached: [old], faults: { partialAttach: true } });
  await assert.rejects(run(client), /did not attach/);
  assert.deepEqual(client.attached, [old], 'the previous corpus did not survive');
});

test('an upload failure mid-run leaves the previous corpus serving', async () => {
  const old = 'custom-documents/raw-channelkb-g900-key-facts-home-1.json';
  const client = fakeClient({ attached: [old], faults: { upload: 2 } });
  await assert.rejects(run(client), /upload failed/);
  assert.deepEqual(client.attached, [old]);
});

test('rollback destroys storage even when detach fails', async () => {
  // Chained, a failed detach skipped the destroy and orphaned every upload.
  const client = fakeClient({ faults: { attach: true, detach: true } });
  await assert.rejects(run(client));
  assert.ok(client.calls.destroy > 0, 'destroy was skipped because detach failed');
});

test('a failed rollback says the previous corpus is still serving', async () => {
  const messages = [];
  const client = fakeClient({ faults: { attach: true, detach: true, destroy: true } });
  await assert.rejects(run(client, { log: (m) => messages.push(m) }));
  assert.match(messages.join(' '), /rollback incomplete/);
  assert.match(messages.join(' '), /still serving/);
});

test('repeated runs are idempotent', async () => {
  const client = fakeClient();
  await run(client, { generation: 1000 });
  await run(client, { generation: 2000 });
  await run(client, { generation: 3000 });
  assert.equal(client.attached.length, 2, `ended with ${client.attached.length} documents`);
  for (const path of client.attached) assert.match(path, /channelkb-g3000-/);
});

test('ownership matching is case-insensitive', () => {
  // The engine lower-cases the title it is handed.
  assert.equal(isOwned('custom-documents/raw-en-us-home-1.json', ['en-US-home']), true);
  assert.equal(isOwned('custom-documents/raw-CHANNELKB-G7-x-1.json', []), true);
  assert.equal(isOwned('custom-documents/raw-someone-else-1.json', ['en-US-home']), false);
});
