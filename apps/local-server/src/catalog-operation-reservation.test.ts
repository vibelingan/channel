import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApprovalPersistenceCommand } from '@vibelingan-channel/db/catalog-detail-staging';
import { JsonFileAdapter } from './json-adapter.ts';

const at = '2026-10-18T00:00:00.000Z';
const start: ApprovalPersistenceCommand = {
  action: 'operation-start',
  productId: 'p',
  operationId: '12345678-1234-4234-8234-123456789012',
  intent: 'publish',
  expectedUpdatedAt: at,
  values: { description: 'Reviewed original' },
};
const query: ApprovalPersistenceCommand = {
  action: 'operation-get',
  productId: start.productId,
  operationId: start.operationId,
};
function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-operation-reservation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      users: [{ _id: 'admin', role: 'admin' }],
      products: [
        {
          _id: 'p',
          name: 'Clock',
          description: '',
          productFamily: 'misc',
          published: false,
          archived: false,
          subcategoryIds: [],
          updatedAt: at,
        },
      ],
    }),
  );
  return { file, adapter: new JsonFileAdapter(file) };
}
test('JSON operation survives reopen; get and duplicate start perform no file write', async (t) => {
  const f = fixture(t);
  const before = await f.adapter.get('products', 'p');
  const begun = await f.adapter.persistCatalogDetailApproval('admin', start);
  assert.ok(begun.ok && 'record' in begun);
  const reopened = new JsonFileAdapter(f.file);
  const bytes = readFileSync(f.file, 'utf8');
  utimesSync(f.file, new Date(1000), new Date(1000));
  const read = await reopened.persistCatalogDetailApproval('admin', query);
  assert.ok(read.ok && 'record' in read && read.current);
  assert.deepEqual(read.record, begun.record);
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
  assert.equal(
    statSync(f.file).mtimeMs,
    1000,
    'read-only operation query must not rewrite the JSON file',
  );
  const repeated = await reopened.persistCatalogDetailApproval('admin', start);
  assert.ok(repeated.ok && 'record' in repeated);
  assert.deepEqual(repeated.record, begun.record);
  assert.equal(statSync(f.file).mtimeMs, 1000, 'duplicate start must not rewrite the JSON file');
  assert.deepEqual(await reopened.get('products', 'p'), before);
});
test('JSON same-ID competing inputs serialize and only the original winner persists', async (t) => {
  const f = fixture(t);
  const other = new JsonFileAdapter(f.file);
  const results = await Promise.allSettled([
    f.adapter.persistCatalogDetailApproval('admin', start),
    other.persistCatalogDetailApproval('admin', {
      ...start,
      values: { description: 'Different operation input' },
    }),
  ]);
  assert.ok(results.every((r) => r.status === 'fulfilled'));
  const answers = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  assert.equal(answers.filter((r) => r.ok).length, 1);
  assert.equal(answers.filter((r) => !r.ok && r.code === 'CONFLICT').length, 1);
  const reopened = new JsonFileAdapter(f.file);
  const answer = await reopened.persistCatalogDetailApproval('admin', query);
  assert.ok(answer.ok && 'record' in answer);
  assert.deepEqual(answer.record.operation.values, { description: 'Reviewed original' });
  assert.equal((await reopened.get('products', 'p'))?.description, '');
  assert.equal((await reopened.get('products', 'p'))?.published, false);
});
