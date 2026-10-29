import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(project, '../../..');
const output =
  process.argv[2] === '--output' && process.argv.length === 4
    ? resolve(process.argv[3])
    : join(repo, `docs/sales-agent/evidence/SG1.2-delivery-defects-${Date.now()}`);
const temporary = await mkdtemp(join(tmpdir(), 'website-delivery-defects-'));
const target = join(temporary, 'apps/functions/sales-integration');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const cases = [
  {
    id: 'wrong_source_receipt',
    file: 'inquiry-sender.ts',
    from: "reply.headers['x-sales-source-sha256'] !== digest",
    to: 'false',
    testFile: 'inquiry-sender.test.ts',
    test: 'body receipt, wrong digest, duplicate header, MIME and status errors are rejected',
    assertion: 'Missing expected rejection',
  },
  {
    id: 'absolute_deadline_removed',
    file: 'inquiry-sender.ts',
    from: '}, this.timeoutMs);',
    to: '}, this.timeoutMs * 50);',
    testFile: 'inquiry-sender.test.ts',
    test: 'absolute deadline rejects an otherwise valid continuously trickled body',
    assertion: 'Missing expected rejection',
  },
  {
    id: 'stream_limit_removed',
    file: 'inquiry-sender.ts',
    from: 'if (size > 16384) {',
    to: 'if (false) {',
    testFile: 'inquiry-sender.test.ts',
    test: 'body receipt, wrong digest, duplicate header, MIME and status errors are rejected',
    assertion: 'Missing expected rejection',
  },
  {
    id: 'terminal_source_allowed',
    file: 'website-delivery.ts',
    from: '      terminal ||',
    to: '      false ||',
    testFile: 'website-delivery.test.ts',
    test: 'invalid owner, incomplete source, changed facts, terminal state and disabled binding never send',
    assertion: "actual: 'accepted'",
  },
  {
    id: 'changed_registered_recipient_allowed',
    file: 'website-delivery.ts',
    from: '!same(event, registration.event) ||',
    to: 'false ||',
    testFile: 'website-delivery.test.ts',
    test: 'changed registration recipient cannot replace the actual saved contact',
    assertion: "actual: 'accepted'",
  },
  {
    id: 'stale_success_overwrites_new_owner',
    file: 'website-delivery.ts',
    from: 'current.lease_id !== leaseId ||',
    to: 'false ||',
    occurrence: 0,
    testFile: 'website-delivery.test.ts',
    test: 'a replacement still in flight cannot be completed by the stale owner',
    assertion: "actual: 'accepted'",
  },
  {
    id: 'stale_failure_overwrites_new_owner',
    file: 'website-delivery.ts',
    from: 'current.lease_id !== leaseId ||',
    to: 'false ||',
    occurrence: 1,
    testFile: 'website-delivery.test.ts',
    test: 'a stale failure cannot schedule retry over the replacement in flight',
    assertion: "actual: 'retry'",
  },
  {
    id: 'accepted_history_fills_scan_page',
    file: 'delivery-store.ts',
    from: "'record.status': db.command.in(['pending', 'retry', 'inflight']),",
    to: '',
    testFile: 'website-delivery.test.ts',
    test: 'accepted audit history never occupies the first active delivery page',
    assertion: 'Expected values to be strictly equal',
  },
  {
    id: 'cursor_never_wraps',
    file: 'website-delivery.ts',
    from: 'if ((cursor?.after ?? null) === after)',
    to: 'if (false)',
    testFile: 'website-delivery.test.ts',
    test: 'multiple active pages and a late lower key are eventually visited; bad registration does not starve others',
    assertion: '4 !== 5',
  },
];
const originals = new Map();
for (const file of new Set(cases.map((item) => item.file)))
  originals.set(file, await readFile(join(project, 'src', file), 'utf8'));
const before = Object.fromEntries([...originals].map(([file, text]) => [file, sha(text)]));
const report = {
  scope:
    'targeted website delivery guards in disposable source copies; no account, provider or real mail',
  status: 'failed',
  baseline: [],
  mutants: [],
  source_hashes_before: before,
};
const run = (item) =>
  spawnSync(
    join(project, 'node_modules/.bin/tsx'),
    [
      '--test',
      '--test-reporter=tap',
      `--test-name-pattern=^${item.test}$`,
      join(target, 'src', item.testFile),
    ],
    { cwd: target, encoding: 'utf8', timeout: 15000 },
  );
try {
  await mkdir(dirname(target), { recursive: true });
  await cp(join(project, 'src'), join(target, 'src'), { recursive: true });
  await symlink(join(project, 'node_modules'), join(target, 'node_modules'));
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'));
  await symlink(join(repo, 'packages'), join(temporary, 'packages'));
  for (const app of ['admin', 'public-api'])
    await symlink(join(repo, 'apps/functions', app), join(temporary, 'apps/functions', app));
  for (const item of cases) {
    const result = run(item);
    report.baseline.push({ id: item.id, returncode: result.status });
    assert.equal(
      result.status,
      0,
      `Clean baseline failed: ${item.id}\n${result.stdout}\n${result.stderr}`,
    );
  }
  for (const item of cases) {
    const original = originals.get(item.file);
    const pieces = original.split(item.from);
    const occurrence = item.occurrence ?? 0;
    assert.equal(
      pieces.length - 1,
      item.occurrence === undefined ? 1 : 2,
      `Mutation anchor changed: ${item.id}`,
    );
    const changed =
      pieces.slice(0, occurrence + 1).join(item.from) +
      item.to +
      pieces.slice(occurrence + 1).join(item.from);
    const path = join(target, 'src', item.file);
    await writeFile(path, changed);
    const result = run(item);
    await writeFile(path, original);
    const detected =
      result.status === 1 &&
      result.stdout.includes(item.assertion) &&
      result.stdout.includes(item.test);
    report.mutants.push({
      id: item.id,
      source: item.file,
      test: item.test,
      expected_assertion: item.assertion,
      before_sha256: sha(original),
      changed_sha256: sha(changed),
      result: detected ? 'killed' : result.status === 0 ? 'survived' : 'invalid_or_timeout',
      returncode: result.status,
    });
    assert.ok(
      detected,
      `Defect not caught by intended assertion: ${item.id}\n${result.stdout}\n${result.stderr}`,
    );
  }
  report.status = 'passed';
} catch (error) {
  report.failure =
    error instanceof Error
      ? error.message.replaceAll(repo, '<repo>').replaceAll(temporary, '<disposable-copy>')
      : 'Defect injection failed';
  process.exitCode = 1;
} finally {
  report.source_hashes_after = Object.fromEntries(
    await Promise.all(
      [...originals.keys()].map(async (file) => [
        file,
        sha(await readFile(join(project, 'src', file))),
      ]),
    ),
  );
  report.source_unchanged = JSON.stringify(report.source_hashes_after) === JSON.stringify(before);
  if (!report.source_unchanged) {
    report.status = 'failed';
    process.exitCode = 1;
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  await rm(temporary, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    status: report.status,
    killed: report.mutants.filter((item) => item.result === 'killed').length,
    source_unchanged: report.source_unchanged,
  }),
);
