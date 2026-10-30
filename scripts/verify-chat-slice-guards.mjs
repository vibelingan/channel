import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (
  !process.env.DATABASE_URL ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)
)
  throw new Error('Isolated local DATABASE_URL required');
const scratch = await mkdtemp(path.join(tmpdir(), 'chat-slice-guards-'));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const checks = [
  {
    name: 'latest question retained',
    directory: 'packages/ai-store',
    file: 'src/store.ts',
    before: 'ORDER BY created_at DESC, id DESC LIMIT 30',
    after: 'ORDER BY created_at ASC, id ASC LIMIT 30',
    test: 'src/store.test.ts',
    pattern: 'bounded model context keeps',
    env: false,
  },

  {
    name: 'historical product field projection',
    directory: 'packages/ai-store',
    file: 'src/store.ts',
    before: 'id: p.id,\n                name: p.name,',
    after: '...p,\n                id: p.id,\n                name: p.name,',
    test: 'src/store.test.ts',
    pattern: 'next question receives only public product facts',
    env: false,
  },
  {
    name: 'public product identity survives contact redaction',
    directory: 'packages/ai-policy',
    file: 'src/index.ts',
    before: 'id: p.id,',
    after: 'id: redactContactData(p.id),',
    test: 'src/index.test.ts',
    pattern: 'public catalog context preserves',
    env: false,
  },
  {
    name: 'public catalog field projection',
    directory: 'apps/ai-worker',
    file: 'src/product-workflow.ts',
    before: 'const data = {',
    after: 'const data = { privateNote: raw.privateNote,',
    test: 'src/product-workflow.test.ts',
    pattern: 'catalog projects only',
    env: false,
  },
  {
    name: 'typed action replay identity',
    directory: 'packages/ai-store',
    file: 'src/store.ts',
    before: ' || !existing.rows[0].same_action',
    after: '',
    test: 'src/store.test.ts',
    pattern: 'typed catalog action is durable',
    env: false,
  },

  {
    name: 'cancel version',
    directory: 'packages/ai-store',
    file: 'src/store.ts',
    before: 'Number(r.control_version) !== version',
    after: 'false',
    test: 'apps/ai-bff/src/chat-v2.test.ts',
    pattern: 'cancel is task-bound',
    env: true,
  },
  {
    name: 'event run identity',
    directory: 'apps/site',
    file: 'src/islands/ai/assistant/http-adapter.ts',
    before: 'event.runId !== turn.runId ||',
    after: '',
    test: 'src/islands/ai/assistant/http-adapter.test.ts',
    pattern: 'foreign terminal',
    env: false,
  },
  {
    name: 'server stream scope',
    directory: 'apps/ai-bff',
    file: 'src/server.ts',
    before: 'if (turn && event.runId !== turn.runId) continue;',
    after: '',
    test: 'src/chat-v2.test.ts',
    pattern: 'v2 streams only',
    env: false,
  },
];
const report = [];
try {
  for (const [index, check] of checks.entries()) {
    const folder = path.join(scratch, String(index));
    await mkdir(folder);
    await writeFile(path.join(folder, 'package.json'), '{"type":"module"}');
    const moduleDir = path.join(root, check.directory);
    const copyRoot = check.directory === 'apps/site' ? 'src/islands/ai/assistant' : 'src';
    await mkdir(path.dirname(path.join(folder, copyRoot)), { recursive: true });
    await cp(path.join(moduleDir, copyRoot), path.join(folder, copyRoot), { recursive: true });
    await symlink(path.join(moduleDir, 'node_modules'), path.join(folder, 'node_modules'));
    const target = path.join(folder, check.file);
    const original = await readFile(target, 'utf8');
    assert.equal(original.split(check.before).length, 2);
    const run = () =>
      spawnSync(
        process.execPath,
        [
          path.join(root, 'apps/site/node_modules/tsx/dist/cli.mjs'),
          '--test',
          '--test-reporter=tap',
          `--test-name-pattern=${check.pattern}`,
          check.env ? path.join(root, check.test) : path.join(folder, check.test),
        ],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            ...(check.env ? { AI_TEST_STORE_MODULE: pathToFileURL(target).href } : {}),
          },
        },
      );
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    await writeFile(target, original.replace(check.before, check.after));
    const mutant = run();
    const killed =
      mutant.status !== 0 && mutant.stdout.includes("code: 'ERR_ASSERTION'") && !mutant.error;
    assert.equal(killed, true, mutant.stdout + mutant.stderr);
    assert.equal(sha(await readFile(path.join(moduleDir, check.file), 'utf8')), sha(original));
    report.push({
      name: check.name,
      baseline: 'passed',
      mutant: 'killed',
      source_sha256: sha(original),
      source_unchanged: true,
    });
  }
  await mkdir(path.join(root, 'output/assistant-chat'), { recursive: true });
  await writeFile(
    path.join(root, 'output/assistant-chat/guards.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
