import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashCanonicalJson } from '../src/index.ts';
import { authorizeTaskRead } from '../src/task-access.ts';
import { pythonCommand } from './python-command.mjs';

type Vector = { id: string; accepted: boolean; now?: number;
  request_patch?: Record<string, unknown>; lease_patch?: Record<string, unknown>;
  handoff_patch?: Record<string, unknown>; permit_patch?: Record<string, unknown> };
const cases: Vector[] = JSON.parse(readFileSync(new URL('../fixtures/task-access-cases.json', import.meta.url), 'utf8'));
const actual = cases.map((item) => {
  const f = JSON.parse(readFileSync(new URL('../fixtures/task-access.json', import.meta.url), 'utf8'));
  for (const key of ['lease', 'handoff', 'request', 'permit'] as const)
    Object.assign(f[key], item[`${key}_patch`] ?? {});
  if (Object.hasOwn(item, 'now')) f.now = item.now;
  if (!item.permit_patch?.request_sha256) f.permit.request_sha256 = hashCanonicalJson(f.request);
  let accepted = false;
  try { authorizeTaskRead(f.lease, f.handoff, f.permit, f.request, f.now); accepted = true; } catch {}
  assert.equal(accepted, item.accepted, `TypeScript: ${item.id}`);
  return { id: item.id, accepted };
});
const result = spawnSync(pythonCommand, [fileURLToPath(new URL('../python/verify_task_access.py', import.meta.url))],
  { input: JSON.stringify(cases), encoding: 'utf8', timeout: 30_000 });
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(JSON.parse(result.stdout), actual);
console.log(JSON.stringify({ status: 'passed', cases: cases.length, languages: ['TypeScript', 'Python'], scope: 'deterministic task-read policy parity; no authenticated service transport or live data' }));
