import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type ContractKind,
  canonicalizeJson,
  hashCanonicalJson,
  parseContract,
  parseStrictJson,
  validateContract,
} from '../src/index.ts';
import { pythonCommand } from './python-command.mjs';

type Result = { accepted: boolean; canonical?: string; sha256?: string };
type Case = {
  id: string;
  operation: string;
  kind: ContractKind;
  value: unknown;
  raw: string;
  expected: Result;
};
const cases: Case[] = JSON.parse(
  readFileSync(new URL('../fixtures/conformance.json', import.meta.url), 'utf8'),
);
const actual = cases.map((item) => {
  let result: Result;
  try {
    if (item.operation === 'validate') {
      validateContract(item.kind, item.value);
      result = { accepted: true };
    } else if (item.operation === 'parse') {
      parseContract(item.kind, item.raw);
      result = { accepted: true };
    } else {
      const value = parseStrictJson(item.raw);
      result = {
        accepted: true,
        canonical: canonicalizeJson(value),
        sha256: hashCanonicalJson(value),
      };
    }
  } catch {
    result = { accepted: false };
  }
  assert.deepEqual(result, item.expected, `TypeScript: ${item.id}`);
  return { id: item.id, ...result };
});
const python = spawnSync(
  pythonCommand,
  [fileURLToPath(new URL('../python/verify.py', import.meta.url))],
  {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    timeout: 30_000,
  },
);
if (python.error) throw python.error;
assert.equal(python.status, 0, python.stderr);
assert.deepEqual(JSON.parse(python.stdout), actual, 'Python/TypeScript conformance');
console.log(
  JSON.stringify({
    status: 'passed',
    cases: cases.length,
    languages: ['TypeScript', 'Python'],
    scope: 'schema, strict JSON and hash parity; no authorization or network',
  }),
);
