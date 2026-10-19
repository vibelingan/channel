import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicationJournal } from './catalog-publication-journal.ts';

const owner = { actorId: 'admin', endpoint: 'https://test.example/api/admin' };
const scope = { productId: 'p', operationId: '12345678-1234-4234-8234-123456789012' };
const digest = 'a'.repeat(64);
const cursor = { imageId: 'photo', ledgerDigest: 'b'.repeat(64), nextOffset: 3 };

test('creation pointers persist separately and cannot be imported as publication tasks', () => {
  const storage = disk();
  const creation = createPublicationJournal(owner, () => storage, 'creation');
  const publication = createPublicationJournal(owner, () => storage);
  const entry = { scope: { ...scope, productId: 'new-product', inputDigest: digest } };
  creation.retain(entry);
  assert.deepEqual(publication.read(), { entries: [], durability: 'persistent', problems: [] });
  assert.deepEqual(createPublicationJournal(owner, () => storage, 'creation').read().entries, [
    entry,
  ]);
  assert.throws(() => publication.import(creation.export()));
  assert.throws(() => creation.import(publication.export()));
});

test('creation recovery refuses a publication media-reference cursor', () => {
  const storage = disk();
  const creation = createPublicationJournal(owner, () => storage, 'creation');
  const entry = { scope: { ...scope, productId: 'new-product', inputDigest: digest } };
  assert.equal(creation.retain(entry).durability, 'persistent');
  assert.throws(() => creation.retain({ ...entry, referenceRecovery: cursor }));
});

test('an original empty publication version survives digest updates and cannot be replaced', () => {
  const storage = disk();
  const publication = createPublicationJournal(owner, () => storage);
  const originalStart = { expectedUpdatedAt: '2026-10-19T00:00:00.000Z' };
  publication.retain({ scope, originalStart });
  publication.retain({ scope: { ...scope, inputDigest: digest } });
  const reopened = createPublicationJournal(owner, () => storage);
  assert.deepEqual(reopened.read().entries, [
    { scope: { ...scope, inputDigest: digest }, originalStart },
  ]);
  assert.throws(() =>
    reopened.retain({
      scope: { ...scope, inputDigest: digest },
      originalStart: { expectedUpdatedAt: '2026-10-19T00:00:01.000Z' },
    }),
  );
  const creation = createPublicationJournal(owner, () => storage, 'creation');
  assert.throws(() =>
    creation.retain({
      scope: { ...scope, productId: 'new-product', inputDigest: digest },
      originalStart,
    }),
  );
});
function disk() {
  const values = new Map<string, string>();
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test('the scope exists before dispatch and survives a new journal instance', () => {
  const storage = disk();
  const first = createPublicationJournal(owner, () => storage);
  assert.equal(first.retain({ scope }).durability, 'persistent');
  assert.deepEqual(createPublicationJournal(owner, () => storage).read().entries, [{ scope }]);
});

test('the same operation receives its digest and cursor without changing its identity', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  assert.equal(
    journal.retain({ scope: { ...scope, inputDigest: digest }, referenceRecovery: cursor })
      .durability,
    'persistent',
  );
  assert.deepEqual(journal.read().entries, [
    { scope: { ...scope, inputDigest: digest }, referenceRecovery: cursor },
  ]);
  assert.equal(storage.length, 1);
});

for (const other of [
  { ...owner, actorId: 'other' },
  { ...owner, endpoint: 'https://prod.example/api/admin' },
])
  test(`recovery pointers are isolated from ${JSON.stringify(other)}`, () => {
    const storage = disk();
    createPublicationJournal(owner, () => storage).retain({ scope });
    const journal = createPublicationJournal(other, () => storage);
    assert.deepEqual(journal.read().entries, []);
    assert.throws(() => journal.import(createPublicationJournal(owner, () => storage).export()));
    assert.equal(storage.length, 1);
  });

test('two tabs retain distinct operations without overwriting an array snapshot', () => {
  const storage = disk();
  const a = createPublicationJournal(owner, () => storage);
  const b = createPublicationJournal(owner, () => storage);
  a.retain({ scope });
  b.retain({ scope: { ...scope, productId: 'q' } });
  assert.equal(a.read().entries.length, 2);
  assert.equal(b.read().entries.length, 2);
});

test('an existing nonempty digest cannot be replaced or erased', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope: { ...scope, inputDigest: digest } });
  assert.throws(() => journal.retain({ scope: { ...scope, inputDigest: 'c'.repeat(64) } }));
  journal.retain({ scope });
  assert.equal(journal.read().entries[0]?.scope.inputDigest, digest);
});

test('blocked storage getters keep an exportable in-memory original scope', () => {
  const journal = createPublicationJournal(owner, () => {
    throw Error('SecurityError');
  });
  assert.equal(journal.retain({ scope }).durability, 'memory');
  assert.deepEqual(journal.read().entries, [{ scope }]);
  assert.equal(journal.read().durability, 'memory');
  const recoveryDisk = disk();
  const restored = createPublicationJournal(owner, () => recoveryDisk);
  restored.import(journal.export());
  assert.deepEqual(restored.read().entries, [{ scope }]);
});

test('a quota error keeps the latest checkpoint available for recovery', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  storage.setItem = () => {
    throw Error('quota');
  };
  assert.equal(
    journal.retain({ scope: { ...scope, inputDigest: digest }, referenceRecovery: cursor })
      .durability,
    'memory',
  );
  assert.deepEqual(journal.read().entries, [
    { scope: { ...scope, inputDigest: digest }, referenceRecovery: cursor },
  ]);
  assert.equal(journal.read().durability, 'memory');
});

test('a corrupt owned record remains on disk and does not hide another valid record', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  const key = storage.key(0);
  assert.ok(key);
  storage.setItem(key, '{bad');
  journal.retain({ scope: { ...scope, productId: 'q' } });
  const result = journal.read();
  assert.ok(result.problems.includes('corrupt'));
  assert.equal(result.entries.length, 1);
  assert.equal(storage.getItem(key), '{bad');
});

test('record inputs and returned pointers are copies, never mutable publication state', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  const value = { scope: { ...scope, inputDigest: digest }, referenceRecovery: { ...cursor } };
  journal.retain(value);
  value.scope.productId = 'other';
  value.referenceRecovery.nextOffset = 20;
  const result = journal.read();
  const entry = result.entries[0];
  assert.ok(entry);
  entry.scope.productId = 'other';
  assert.deepEqual(journal.read().entries, [
    { scope: { ...scope, inputDigest: digest }, referenceRecovery: cursor },
  ]);
});

test('exported recovery contains only bounded owner and pointers, no product values or credentials', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  const document = JSON.parse(journal.export());
  assert.deepEqual(Object.keys(document).sort(), ['entries', 'owner', 'schemaVersion']);
  assert.deepEqual(document.owner, owner);
  assert.deepEqual(document.entries, [{ scope }]);
  assert.throws(() => journal.retain({ scope, values: { token: 'secret' } }));
});

test('an invalid imported item leaves every existing pointer unchanged', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  const before = [...storage.values];
  assert.throws(() =>
    journal.import(
      JSON.stringify({
        schemaVersion: 'catalog-publication-recovery-v1',
        owner,
        entries: [
          { scope: { ...scope, productId: 'q' } },
          { scope: { ...scope, operationId: 'bad' } },
        ],
      }),
    ),
  );
  assert.deepEqual([...storage.values], before);
});

for (const fault of ['length', 'key', 'getItem'])
  test(`a ${fault} read failure keeps the last known original scope`, () => {
    const storage = disk();
    const journal = createPublicationJournal(owner, () => storage);
    journal.retain({ scope });
    if (fault === 'length')
      Object.defineProperty(storage, 'length', {
        get() {
          throw Error('blocked');
        },
      });
    if (fault === 'key')
      storage.key = () => {
        throw Error('blocked');
      };
    if (fault === 'getItem')
      storage.getItem = () => {
        throw Error('blocked');
      };
    const result = journal.read();
    assert.equal(result.durability, 'memory');
    assert.ok(result.problems.includes('unavailable'));
    assert.deepEqual(result.entries, [{ scope }]);
  });

test('quota fallback explicitly reports unavailable durable storage', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  storage.setItem = () => {
    throw Error('quota');
  };
  assert.ok(journal.retain({ scope }).problems.includes('unavailable'));
});

for (const fault of ['remove-throws', 'remove-silent', 'write-silent'])
  test(`an unconfirmed ${fault} never silently loses the original pointer`, () => {
    const storage = disk();
    const journal = createPublicationJournal(owner, () => storage);
    journal.retain({ scope });
    if (fault === 'remove-throws')
      storage.removeItem = () => {
        throw Error('blocked');
      };
    if (fault === 'remove-silent') storage.removeItem = () => {};
    if (fault === 'write-silent') storage.setItem = () => {};
    const result =
      fault === 'write-silent'
        ? journal.retain({ scope: { ...scope, inputDigest: digest } })
        : journal.forget(scope);
    assert.equal(result.durability, 'memory');
    assert.equal(result.entries[0]?.scope.operationId, scope.operationId);
    if (fault === 'write-silent') assert.equal(result.entries[0]?.scope.inputDigest, digest);
  });

test('forget removes only an explicitly selected pointer from the current account and environment', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  journal.retain({ scope: { ...scope, productId: 'q' } });
  createPublicationJournal({ ...owner, actorId: 'other' }, () => storage).retain({ scope });
  assert.deepEqual(journal.forget(scope).entries, [{ scope: { ...scope, productId: 'q' } }]);
  assert.equal(storage.length, 2);
});

test('a failed repair never drops an earlier unsaved in-memory checkpoint', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  storage.setItem = () => {
    throw Error('quota');
  };
  journal.retain({ scope: { ...scope, inputDigest: digest }, referenceRecovery: cursor });
  const name = storage.key(0);
  assert.ok(name);
  storage.values.set(name, '{bad');
  assert.throws(() => journal.retain({ scope: { ...scope, inputDigest: digest } }));
  assert.deepEqual(journal.read().entries, [
    { scope: { ...scope, inputDigest: digest }, referenceRecovery: cursor },
  ]);
});

test('import preflights every existing corrupt target before writing any new pointer', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  const name = storage.key(0);
  assert.ok(name);
  storage.values.set(name, '{bad');
  const before = [...storage.values];
  assert.throws(() =>
    journal.import(
      JSON.stringify({
        schemaVersion: 'catalog-publication-recovery-v1',
        owner,
        entries: [{ scope: { ...scope, productId: 'q' } }, { scope }],
      }),
    ),
  );
  assert.deepEqual([...storage.values], before);
});

test('import rejects a later conflicting digest before retaining any earlier new pointer', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope: { ...scope, inputDigest: digest } });
  const before = [...storage.values];
  assert.throws(() =>
    journal.import(
      JSON.stringify({
        schemaVersion: 'catalog-publication-recovery-v1',
        owner,
        entries: [
          { scope: { ...scope, productId: 'q' } },
          { scope: { ...scope, inputDigest: 'c'.repeat(64) } },
        ],
      }),
    ),
  );
  assert.deepEqual([...storage.values], before);
});

for (const value of [
  null,
  [],
  { scope: { ...scope, actorId: 'other' } },
  { scope, referenceRecovery: cursor },
  { scope: { ...scope, operationId: 'bad' } },
])
  test(`invalid stored input is refused without mutation ${JSON.stringify(value)}`, () => {
    const storage = disk();
    const journal = createPublicationJournal(owner, () => storage);
    assert.throws(() => journal.retain(value));
    assert.equal(storage.length, 0);
    assert.equal(journal.read().entries.length, 0);
  });

for (const endpoint of [
  'https://token:secret@test.example/api/admin',
  'https://test.example/api/admin?token=secret',
  'file:///private/data',
  '/api/admin',
])
  test(`an ambiguous or credential-bearing endpoint cannot partition recovery ${endpoint}`, () => {
    assert.throws(() => createPublicationJournal({ ...owner, endpoint }, () => disk()));
  });

test('a duplicate imported original operation is refused as a whole document', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  assert.throws(() =>
    journal.import(
      JSON.stringify({
        schemaVersion: 'catalog-publication-recovery-v1',
        owner,
        entries: [{ scope }, { scope }],
      }),
    ),
  );
  assert.equal(storage.length, 0);
});

test('advancing a known operation reads only its own storage key instead of rescanning the whole journal', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  let scans = 0;
  const original = storage.key;
  storage.key = (index) => {
    scans++;
    return original(index);
  };
  journal.retain({ scope: { ...scope, inputDigest: digest } });
  assert.equal(scans, 0);
});

function seed(storage: ReturnType<typeof disk>, count: number) {
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  const name = storage.key(0);
  assert.ok(name);
  const bytes = storage.getItem(name);
  assert.ok(bytes);
  const value = JSON.parse(bytes);
  const prefix = name.slice(0, -JSON.stringify([scope.productId, scope.operationId]).length);
  for (let index = 1; index < count; index++) {
    const productId = `product-${index}`;
    storage.values.set(
      prefix + JSON.stringify([productId, scope.operationId]),
      JSON.stringify({ ...value, entry: { scope: { ...scope, productId } } }),
    );
  }
}

test('reaching the admission limit never evicts an unresolved recovery pointer', () => {
  const storage = disk();
  seed(storage, 500);
  const journal = createPublicationJournal(owner, () => storage);
  const before = [...storage.values];
  assert.equal(journal.read().entries.length, 500);
  assert.throws(() => journal.retain({ scope: { ...scope, productId: 'new' } }));
  assert.deepEqual([...storage.values], before);
  assert.equal(JSON.parse(journal.export()).entries.length, 500);
});

test('an incomplete bounded scan never masquerades as a complete recovery export', () => {
  const storage = disk();
  seed(storage, 501);
  const journal = createPublicationJournal(owner, () => storage);
  const before = [...storage.values];
  assert.ok(journal.read().problems.includes('limit'));
  assert.throws(() => journal.export());
  const single = JSON.parse(journal.export({ ...scope, productId: 'product-500' }));
  assert.deepEqual(single.entries, [{ scope: { ...scope, productId: 'product-500' } }]);
  assert.deepEqual([...storage.values], before);
});

test('origin scan limits retain records and expose a recoverable selected export', () => {
  const storage = disk();
  const journal = createPublicationJournal(owner, () => storage);
  journal.retain({ scope });
  for (let index = 0; index < 2001; index++) storage.values.set(`unrelated-${index}`, 'value');
  assert.ok(journal.read().problems.includes('limit'));
  assert.throws(() => journal.retain({ scope: { ...scope, productId: 'new' } }));
  assert.deepEqual(JSON.parse(journal.export(scope)).entries, [{ scope }]);
  assert.equal(storage.length, 2002);
});

test('two original operations for the same product keep separate recovery pointers', () => {
  const storage = disk();
  const first = createPublicationJournal(owner, () => storage);
  const second = createPublicationJournal(owner, () => storage);
  first.retain({ scope });
  second.retain({ scope: { ...scope, operationId: '22345678-1234-4234-8234-123456789012' } });
  assert.equal(storage.length, 2);
  assert.equal(first.read().entries.length, 2);
});

for (const response of ['read', 'retain'])
  test(`a returned ${response} snapshot cannot mutate the only in-memory recovery pointer`, () => {
    const journal = createPublicationJournal(owner, () => {
      throw Error('blocked');
    });
    const retained = journal.retain({ scope });
    const snapshot = response === 'read' ? journal.read() : retained;
    const pointer = snapshot.entries[0];
    assert.ok(pointer);
    pointer.scope.productId = 'other';
    assert.deepEqual(journal.read().entries, [{ scope }]);
  });
