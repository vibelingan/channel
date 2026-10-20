import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonFileAdapter } from './json-adapter.ts';

test('queued local database operations let HTTP requests run before the work queue drains', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-json-http-fairness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  await writeFile(file, JSON.stringify({ products: [{ _id: 'p', name: 'Original' }] }));
  const adapter = new JsonFileAdapter(file);
  let finished = false;
  const server = createServer((_req, res) => res.end(JSON.stringify({ duringWork: !finished })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = fetch(`http://127.0.0.1:${address.port}`);
  const work = (async () => {
    for (let index = 0; index < 100; index++) {
      const row = await adapter.get('products', 'p');
      assert.deepEqual(row, { _id: 'p', name: 'Original' });
    }
    finished = true;
  })();
  try {
    assert.deepEqual(await (await response).json(), { duringWork: true });
  } finally {
    await work;
  }
});
