import assert from 'node:assert/strict';
import test from 'node:test';
import { requireFunctionSourceAncestor } from './images/source-ancestry.mjs';
const beforeVersion = 'a'.repeat(40);
const sourceSha = 'b'.repeat(40);
const input = { beforeVersion, sourceSha, token: 'unit-test-identity' };
const reply =
  (status, behind_by, sha = beforeVersion) =>
  async () => ({
    status: 200,
    body: Buffer.from(JSON.stringify({ status, behind_by, merge_base_commit: { sha } })),
  });
test('current source history must be in the candidate, even when candidate CI passed', async () => {
  assert.equal(
    (await requireFunctionSourceAncestor({ ...input, request: reply('ahead', 0) })).status,
    'ahead',
  );
  for (const request of [
    reply('diverged', 1),
    reply('behind', 1),
    reply('ahead', 0, 'c'.repeat(40)),
    async () => ({ status: 403 }),
  ])
    await assert.rejects(requireFunctionSourceAncestor({ ...input, request }));
});
test('invalid live source stops before a GitHub request', async () => {
  let calls = 0;
  await assert.rejects(
    requireFunctionSourceAncestor({
      ...input,
      beforeVersion: 'unknown',
      request: async () => {
        calls++;
      },
    }),
  );
  assert.equal(calls, 0);
});
