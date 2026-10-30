import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(join(tmpdir(), 'assistant-inquiry-defects-'));
const checks = [
  {
    name: 'frozen submission fingerprint',
    module: 'packages/db',
    file: 'assistant-inquiry.ts',
    from: 'meta?.fingerprint !== fingerprint ||',
    to: '',
    test: 'assistant-inquiry.test.ts',
    pattern: 'concurrent retries and a fresh store',
  },
  {
    name: 'active installation on recovery',
    module: 'packages/db',
    file: 'assistant-inquiry.ts',
    from: 'assertSalesInstallation(install?.record, scope);',
    to: '',
    test: 'assistant-inquiry.test.ts',
    pattern: 'missing consent, spoofed scope',
  },
  {
    name: 'atomic delivery registration',
    module: 'packages/db',
    file: 'sales-inquiry-submission.ts',
    from: "await write('channelSalesSourceDeliveries', key, {",
    to: "await write('mutated_missing_deliveries', key, {",
    test: 'assistant-inquiry.test.ts',
    pattern: 'failure after project and registration',
  },
  {
    name: 'dedicated intake credential',
    module: 'apps/functions/sales-integration',
    file: 'assistant-intake.ts',
    from: 'if (!supplied || !timingSafeEqual(digest(supplied), digest(token)))',
    to: 'if (false)',
    test: 'assistant-intake.test.ts',
    pattern: 'dedicated credential and strict',
  },
];
const report = [];
try {
  for (const [index, check] of checks.entries()) {
    const root = join(scratch, String(index));
    await mkdir(root);
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await cp(join(repo, check.module, 'src'), join(root, 'src'), { recursive: true });
    await symlink(join(repo, check.module, 'node_modules'), join(root, 'node_modules'));
    const file = join(root, 'src', check.file);
    const source = await readFile(file, 'utf8');
    assert.equal(source.split(check.from).length, 2, check.name);
    const run = () =>
      spawnSync(
        process.execPath,
        [
          join(repo, 'node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/cli.mjs'),
          '--test',
          '--test-reporter=tap',
          `--test-name-pattern=${check.pattern}`,
          join(root, 'src', check.test),
        ],
        { cwd: repo, encoding: 'utf8', timeout: 30000 },
      );
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    assert.match(baseline.stdout, /# pass [1-9]/);
    await writeFile(file, source.replace(check.from, check.to));
    const broken = run();
    const killed =
      broken.status === 1 &&
      /ERR_ASSERTION/.test(broken.stdout) &&
      broken.stdout.includes('not ok 1 - ') &&
      !broken.error;
    report.push({
      name: check.name,
      baseline: 'passed',
      mutation: killed ? 'killed' : broken.error ? 'invalid_or_timeout' : 'survived',
    });
    await writeFile(
      join(repo, 'docs/sales-agent/evidence/assistant-inquiry-defects.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    assert.ok(killed, `${check.name}\n${broken.stdout}${broken.stderr}`);
    assert.equal(await readFile(join(repo, check.module, 'src', check.file), 'utf8'), source);
  }
  console.log(JSON.stringify(report));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
