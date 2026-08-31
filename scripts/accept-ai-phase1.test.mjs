/**
 * The acceptance observer must be able to turn red.
 *
 * Two ways it silently could not:
 *  - the negative case accepted ANY error event, so a provider outage, a quota
 *    trip or a timeout proved that unapproved sources are blocked;
 *  - the code it looks for is a literal in a plain-Node script, so renaming the
 *    constant in the policy package would make the assertion unsatisfiable
 *    while nothing failed to compile.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

const scriptSource = read('scripts/accept-ai-phase1.mjs');
const policySource = read('packages/ai-policy/src/index.ts');
const errorsSource = read('packages/ai-engine/src/errors.ts');

const literalIn = (source) => source.match(/PUBLICATION_BLOCKED\s*=\s*'([a-z_]+)'/)?.[1] ?? null;

test('the observer and the policy package name the same code', () => {
  const inScript = literalIn(scriptSource);
  const inPolicy = literalIn(policySource);
  assert.ok(inScript, 'the acceptance script declares no publication-gate code');
  assert.ok(inPolicy, 'the policy package exports no publication-gate code');
  assert.equal(
    inScript,
    inPolicy,
    'the acceptance script looks for a code the gate no longer emits, so the negative test can never pass',
  );
});

test('the code is part of the engine’s closed error taxonomy', () => {
  const code = literalIn(policySource);
  assert.match(
    errorsSource,
    new RegExp(`'${code}',`),
    `${code} is not in ENGINE_ERROR_CATEGORIES, so it could never reach the wire`,
  );
});

test('the code is emitted ONLY by the publication gate, never by another path', () => {
  // If any other module can produce it, the negative case stops being evidence
  // about the gate specifically.
  const emitters = [];
  for (const rel of [
    'packages/ai-policy/src/index.ts',
    'apps/ai-worker/src/worker.ts',
    'apps/ai-bff/src/server.ts',
    'packages/ai-engine-anythingllm/src/engine.ts',
  ]) {
    const source = read(rel);
    // A literal use of the string, excluding the taxonomy declaration itself.
    if (/category:\s*(PUBLICATION_BLOCKED|'publication_blocked')/.test(source)) emitters.push(rel);
  }
  assert.deepEqual(
    emitters,
    ['packages/ai-policy/src/index.ts'],
    'more than one module emits the publication-gate code',
  );
});

test('the negative assertion requires the gate code, not merely an error', () => {
  // Guards the exact regression: `negativeTypes[0] === 'error'` alone.
  assert.match(
    scriptSource,
    /negativeCategories\[0\]\s*===\s*PUBLICATION_BLOCKED/,
    'the negative case does not require the publication-gate code',
  );
});

test('unrelated failures cannot satisfy the negative case', () => {
  // The observer decides from the category alone, so this is a data test over
  // the same predicate the script applies.
  const decide = (categories, types) =>
    types.length === 1 &&
    types[0] === 'error' &&
    categories.length === 1 &&
    categories[0] === 'publication_blocked';

  for (const impostor of ['quota', 'timeout', 'transient', 'unavailable', 'knowledge_empty']) {
    assert.equal(
      decide([impostor], ['error']),
      false,
      `a ${impostor} error must not prove the publication gate fired`,
    );
  }
  assert.equal(decide(['publication_blocked'], ['error']), true);
});

test('a bypassed gate turns the observer red rather than green', () => {
  // Gate removed => the answer streams. That is tokens and citations and a
  // final, which must not satisfy the negative case.
  const decide = (categories, types) =>
    types.length === 1 &&
    types[0] === 'error' &&
    categories.length === 1 &&
    categories[0] === 'publication_blocked';
  assert.equal(decide([], ['token', 'citation', 'final']), false);
  assert.equal(decide([], ['token', 'final']), false);
});
