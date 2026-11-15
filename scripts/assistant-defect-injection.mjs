#!/usr/bin/env node
/**
 * Defect injection for the assistant's seven release gates (ROUND2-DESIGN §9,
 * MIU 20). Each gate first runs its tests on the unmodified code, then removes
 * one protection with a tiny patch, runs the same tests, and restores the file:
 *
 *   killed   – baseline passed, the patched run failed: the protection is tested
 *   survived – the patched run passed too: the protection is NOT tested
 *   invalid  – the patch did not apply, a pattern matched no test, or the
 *              baseline already failed, so nothing was proven
 *
 * Every run gets its own fresh database (created next to the one named, then
 * dropped), so jobs left queued by one run cannot decide another. Each run's
 * output is kept in output/assistant-defects/.
 *
 * Run by hand before each release, not in CI:
 *   ASSISTANT_DEFECT_DATABASE_URL=postgres://ai:ai@127.0.0.1:55432/guard_test \
 *     node scripts/assistant-defect-injection.mjs
 *
 * Files are restored even when a run is interrupted; a target with
 * uncommitted changes is refused, so local work is never overwritten.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const database = process.env.ASSISTANT_DEFECT_DATABASE_URL;
if (!database || !['127.0.0.1', 'localhost'].includes(new URL(database).hostname))
  throw new Error('ASSISTANT_DEFECT_DATABASE_URL must name a local test database');

const tsxTest = (pkg, file, pattern) => ({
  label: `${pkg} ${file} /${pattern}/`,
  args: ['--filter', pkg, 'exec', 'tsx', '--test', `--test-name-pattern=${pattern}`, file],
});

const playwright = (config, grep) => ({
  label: `${config} --grep "${grep}"`,
  args: ['exec', 'playwright', 'test', '-c', config, '--project', 'desktop', '--grep', grep],
  // Never reuse a server left running by another lane: it would not carry
  // the patch or this run's database.
  env: { CI: '1' },
});

const GATES = [
  {
    id: 1,
    title: 'Five-card batch limit removed',
    file: 'apps/ai-worker/src/product-workflow.ts',
    find: 'const products = ranked.slice(0, PRODUCT_BATCH_SIZE);',
    replace: 'const products = ranked;',
    tests: [
      tsxTest(
        '@vibelingan-channel/ai-worker',
        'src/product-workflow.test.ts',
        'hundred_matches_show_at_most_five',
      ),
    ],
  },
  {
    id: 2,
    title: 'Inquiry recheck uses a new submission key',
    file: 'apps/site/src/islands/ai/assistant/inquiry.ts',
    find: "    phase: 'saving',\n    key: view.key,\n    draft: view.draft,",
    replace: "    phase: 'saving',\n    key: crypto.randomUUID(),\n    draft: view.draft,",
    tests: [
      tsxTest(
        '@vibelingan-channel/site',
        'src/islands/ai/assistant/inquiry.test.ts',
        'lost_receipt_recovers_same_submission',
      ),
      // repeated_confirm_has_one_record, through the real components.
      playwright(
        'playwright.assistant.config.ts',
        'unknown inquiry retries the frozen original key',
      ),
    ],
  },
  {
    id: 3,
    title: 'Snapshot readable without the conversation credential',
    file: 'apps/ai-bff/src/server.ts',
    find: '      if (!(await authorizeConversation(request, store, route.conversationId))) {',
    replace:
      "      if (route.action !== 'snapshot' && !(await authorizeConversation(request, store, route.conversationId))) {",
    tests: [
      tsxTest(
        '@vibelingan-channel/ai-bff',
        'src/chat-v2.test.ts',
        'snapshot restores the credential holder',
      ),
    ],
  },
  {
    id: '4a',
    title: 'Requirement summary lets an old quantity overwrite the new one',
    file: 'packages/ai-policy/src/need.ts',
    find: "    if (current?.basis === 'stated' && proposed.basis === 'inferred') continue;\n",
    replace: '',
    tests: [
      tsxTest('@vibelingan-channel/ai-policy', 'src/need.test.ts', 'cannot turn 700 back into 500'),
      tsxTest('@vibelingan-channel/ai-worker', 'src/memory.test.ts', 'thirty turns later'),
    ],
  },
  {
    id: '4b',
    title: 'A changed requirement is sent under the earlier submission key',
    file: 'apps/site/src/islands/ai/assistant/inquiry.ts',
    find: "    phase: 'editing',\n    key: key(),\n    errors: {},\n    draft: {\n      ...view.draft,\n",
    replace:
      "    phase: 'editing',\n    key: view.key,\n    errors: {},\n    draft: {\n      ...view.draft,\n",
    tests: [
      tsxTest(
        '@vibelingan-channel/site',
        'src/islands/ai/assistant/inquiry.test.ts',
        'changed_need_preserves_contact',
      ),
    ],
  },
  {
    id: 5,
    title: 'Per-question input budget gate removed',
    file: 'packages/ai-engine-vibekb/src/index.ts',
    find: '        if (estimateMessages(messages) > questionLeft) {',
    replace: '        if (estimateMessages(messages) < 0) {',
    tests: [
      tsxTest(
        '@vibelingan-channel/ai-engine-vibekb',
        'src/index.test.ts',
        'spent its input budget',
      ),
    ],
  },
  {
    id: 6,
    title: 'Test identity decided by the company name again',
    file: 'apps/functions/sales-integration/src/assistant-intake.ts',
    find: "  if (scope.environment !== 'test') throw new Error('Test intake requires a test installation');\n  return store;",
    replace:
      "  if (scope.environment !== 'test') throw new Error('Test intake requires a test installation');\n  return { ...store, submit: (input) => (/test/i.test(input.submission.company) ? store.submit(input) : Promise.reject(new Error('not a test company'))) };",
    tests: [
      tsxTest(
        '@vibelingan-channel/fn-sales-integration',
        'src/assistant-intake.test.ts',
        'ordinary_company_in_test_scope_can_submit',
      ),
    ],
  },
  {
    id: 7,
    title: 'Restore resumes without the original idempotency key',
    file: 'apps/site/src/islands/ai/assistant/http-adapter.ts',
    find: "            if (['queued', 'creating', 'running'].includes(m.status))\n              resume = { conversationKey: record.conversationKey, ...record.turn };",
    replace:
      "            if (['queued', 'creating', 'running'].includes(m.status))\n              resume = { conversationKey: record.conversationKey, ...record.turn, idempotencyKey: crypto.randomUUID() };",
    tests: [
      tsxTest(
        '@vibelingan-channel/site',
        'src/islands/ai/assistant/http-adapter.test.ts',
        'inflight_reply_resumes_without_second_model_run',
      ),
    ],
  },
];

const only = process.argv.slice(2);
const selected = only.length ? GATES.filter((g) => only.includes(String(g.id))) : GATES;
const originals = new Map();
function restoreAll() {
  for (const [path, text] of originals) writeFileSync(path, text);
  originals.clear();
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    restoreAll();
    process.exit(130);
  });

function clean(file) {
  return spawnSync('git', ['diff', '--quiet', 'HEAD', '--', file], { cwd: root }).status === 0;
}

const logs = join(root, 'output/assistant-defects');
mkdirSync(logs, { recursive: true });

async function freshDatabase(label, use) {
  const name = `defect_${label}_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: database });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
    const url = new URL(database);
    url.pathname = `/${name}`;
    return use(url.href);
  } finally {
    await admin.query(`drop database if exists "${name}" with (force)`).catch(() => undefined);
    await admin.end();
  }
}

async function runTests(gate, phase) {
  const runs = [];
  for (const [index, t] of gate.tests.entries()) {
    const run = await freshDatabase(`g${gate.id}_${phase}_${index}`, (url) =>
      spawnSync('pnpm', t.args, {
        cwd: root,
        env: { ...process.env, ...t.env, DATABASE_URL: url, CHAT_TEST_DATABASE_URL: url },
        encoding: 'utf8',
        timeout: 300_000,
      }),
    );
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    writeFileSync(join(logs, `gate-${gate.id}-${phase}-${index}.txt`), output);
    // A pattern that matched no test proves nothing either. node --test
    // reports "ℹ tests N" (spec) or, on Node 22 without a TTY, "# tests N" (TAP).
    const ran = /^(?:ℹ|#) tests [1-9]|\b[1-9]\d* (passed|failed)\b/m.test(output);
    runs.push({ test: t.label, failed: run.status !== 0, ran });
  }
  return runs;
}

const results = [];
for (const gate of selected) {
  const path = join(root, gate.file);
  if (!clean(gate.file)) {
    results.push({ ...gate, outcome: 'invalid', detail: 'target has uncommitted changes' });
    continue;
  }
  const text = readFileSync(path, 'utf8');
  if (text.split(gate.find).length !== 2) {
    results.push({ ...gate, outcome: 'invalid', detail: 'patch did not apply exactly once' });
    continue;
  }
  const baseline = await runTests(gate, 'baseline');
  if (baseline.some((r) => r.failed || !r.ran)) {
    results.push({ ...gate, outcome: 'invalid', detail: 'baseline failed', runs: baseline });
    continue;
  }
  originals.set(path, text);
  writeFileSync(path, text.replace(gate.find, gate.replace));
  let runs = [];
  try {
    runs = await runTests(gate, 'mutant');
  } finally {
    restoreAll();
  }
  const outcome = runs.some((r) => !r.ran)
    ? 'invalid'
    : runs.every((r) => r.failed)
      ? 'killed'
      : 'survived';
  results.push({ ...gate, outcome, runs });
}

const report = results.map(({ id, title, file, outcome, runs, detail }) => ({
  id,
  title,
  file,
  outcome,
  ...(detail ? { detail } : {}),
  ...(runs ? { runs } : {}),
}));
writeFileSync(
  join(logs, 'results.json'),
  `${JSON.stringify({ recordedAt: new Date().toISOString(), report }, null, 2)}\n`,
);
for (const r of report) console.log(`${String(r.id).padEnd(3)} ${r.outcome.padEnd(9)} ${r.title}`);
process.exitCode = report.every((r) => r.outcome === 'killed') ? 0 : 1;
