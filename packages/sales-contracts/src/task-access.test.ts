import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hashCanonicalJson, validateContract } from './index.ts';
import { authorizeTaskRead, issueTaskPermit, TaskAccessDenied } from './task-access.ts';

const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/task-access.json', import.meta.url), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('../fixtures/task-access-cases.json', import.meta.url), 'utf8'));
for (const item of cases) {
  test(`task_read_${item.id}`, () => {
    const f = fixture();
    for (const key of ['lease', 'handoff', 'request', 'permit'])
      Object.assign(f[key], item[`${key}_patch`] ?? {});
    if (Object.hasOwn(item, 'now')) f.now = item.now;
    if (!item.permit_patch?.request_sha256) f.permit.request_sha256 = hashCanonicalJson(f.request);
    const call = () => authorizeTaskRead(f.lease, f.handoff, f.permit, f.request, f.now);
    if (item.accepted) assert.doesNotThrow(call);
    else assert.throws(call, TaskAccessDenied);
  });
}

test('fresh task state permits only verified current preparing run', () => {
  const f = fixture();
  assert.deepEqual(issueTaskPermit(f.request, f.authority, f.now), f.permit);
  for (const patch of [
    { source_verified: false }, { mode: 'paused' }, { mode: 'human_owned' },
    { work_state: 'finished' }, { run_id: 'old_run' }, { task_revision: 2 },
    { client_id: 'client_b' }, { control_epoch: 2 }, { allowed_actions: ['product.read'] },
    { source_verified: 1 }, { task_revision: true }, { mode: 'unknown' },
  ]) assert.throws(() => issueTaskPermit(f.request, { ...f.authority, ...patch }, f.now), TaskAccessDenied);
});

test('new authorization schemas reject omitted scope, numeric task ids and unknown fields', () => {
  const f = fixture();
  for (const [kind, value] of [
    ['sales-auth-handoff', f.handoff], ['sales-auth-lease', f.lease],
    ['sales-auth-request', f.request], ['sales-auth-authority', f.authority],
    ['sales-auth-permit', f.permit],
  ] as const) {
    assert.deepEqual(validateContract(kind, value), value);
    assert.throws(() => validateContract(kind, { ...value, protocol: 'sales-auth/2' }));
    assert.throws(() => validateContract(kind, { ...value, admin: true }));
  }
});

test('task ids cannot encode paths even when every record agrees', () => {
  const f = fixture();
  f.lease.task_id = f.request.task_id = f.authority.task_id = 'task/../other_task';
  f.permit.request_sha256 = hashCanonicalJson(f.request);
  assert.throws(() => issueTaskPermit(f.request, f.authority, f.now), TaskAccessDenied);
  assert.throws(() => authorizeTaskRead(f.lease, f.handoff, f.permit, f.request, f.now), TaskAccessDenied);
});
