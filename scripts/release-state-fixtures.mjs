import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { identity } from './release/input.mjs';

export const policy = {
  repository: 'fixture/channel',
  envId: 'fixture-env',
  siteOrigin: 'https://fixture.example',
  canaryPrefix: '__release-canary/',
};
export const hashA = 'a'.repeat(64);
export const hashB = 'b'.repeat(64);
export function component(label = 'A') {
  return {
    releaseId: `release-${label}`,
    codeSha: label.toLowerCase().repeat(40),
    contentSha256: label.toLowerCase().repeat(64),
    artifact: {
      repository: policy.repository,
      workflowPath: '.github/workflows/release.yml',
      runId: label === 'A' ? '1' : '2',
      artifactId: label === 'A' ? '10' : '20',
      manifestSha256: label.toLowerCase().repeat(64),
      expiresAt: '2026-12-01T00:00:00Z',
    },
  };
}
export const composition = (label = 'A') => ({ static: component(label) });

// Test storage commits whole snapshots and can reopen a real JSON file.
// Live CloudBase isolation is tested separately through the installed SDK.
export function memoryStore(file) {
  let records = new Map(file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
  let tail = Promise.resolve();
  let commits = 0;
  let failAck = false;
  const key = (table, id) => `${table}/${id}`;
  return {
    envId: policy.envId,
    transact(callback) {
      const pending = tail.then(async () => {
        const snapshot = structuredClone(records);
        const read = new Set();
        const writes = new Set();
        const value = await callback({
          async get(table, id) {
            if (writes.size) throw new Error('Read after write');
            read.add(key(table, id));
            return structuredClone(snapshot.get(key(table, id)) ?? null);
          },
          put(table, id, value) {
            const k = key(table, id);
            if (!read.has(k)) throw new Error('Blind write');
            writes.add(k);
            snapshot.set(k, structuredClone(value));
          },
        });
        if (writes.size) {
          records = snapshot;
          commits++;
          if (file) writeFileSync(file, JSON.stringify([...records]));
          if (failAck) {
            failAck = false;
            throw new Error('Commit response lost');
          }
        }
        return structuredClone(value);
      });
      tail = pending.catch(() => {});
      return pending;
    },
    inspect: () => structuredClone([...records]),
    replace(table, id, value) {
      records.set(key(table, id), structuredClone(value));
    },
    loseNextAck() {
      failAck = true;
    },
    get commits() {
      return commits;
    },
  };
}
export const runner = (id) => ({
  ownerRunId: id,
  runnerRef: `github:fixture/channel:${id}:attempt-1:job-1`,
});
export const plan = (steps = 2) => ({ planSha256: hashA, acceptanceHash: hashB, stepCount: steps });
export const clock = () => {
  let value = Date.parse('2026-10-21T00:00:00Z');
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
};
export function receipt(step, status = 'verified', changes = {}) {
  return {
    status,
    executionId: step.executionId,
    planSha256: step.planSha256,
    operationId: step.operationId,
    intentHash: step.intentHash,
    subject: status === 'submitted' ? step.subject : step.verifySubject,
    expectedHash: step.afterHash,
    observedHash: step.afterHash,
    terminal: status === 'verified',
    ...changes,
  };
}
export const stepInput = (kind = 'write') => ({
  stepId: randomUUID(),
  component: kind === 'accept' ? 'scope' : 'static',
  kind,
  beforeHash: kind === 'accept' ? hashB : hashA,
  afterHash: hashB,
  subject: kind === 'accept' ? 'accept' : 'upload:index.html',
  verifySubject: kind === 'accept' ? 'accept' : 'read:index.html',
  executionId: 'execution-1',
});
export const compositionHash = (label) => identity(composition(label));
