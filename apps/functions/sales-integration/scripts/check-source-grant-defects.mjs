import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(project, '../../..');
const temporary = await mkdtemp(join(tmpdir(), 'sales-grant-defects-'));
const target = join(temporary, 'apps/functions/sales-integration');
const testFile = join(target, 'src/source-grants.test.ts');
const mutants = [
  {
    id: 'owned_source',
    file: 'sources.ts',
    from: 'row.client_id === deps.client_id &&',
    to: 'true &&',
    test: 'missing or conflicting record ownership is denied even with active installation',
  },
  {
    id: 'oem_finalized',
    file: 'source-grants.ts',
    from: "raw?.salesSubmissionState !== 'finalized'",
    to: 'false',
    test: 'OEM requires final matching submission marker, active file and nonterminal source',
  },
  {
    id: 'saved_source_facts',
    file: 'source-grants.ts',
    from: 'if (!equal(incomingFacts, sourceFacts)) denied();',
    to: 'if (false) denied();',
    test: 'canonical source facts rather than claimed summary, recipient or channel determine authorization',
  },
  {
    id: 'revoked_handoff',
    file: 'source-grants.ts',
    from: "validateContract('sales-auth-handoff', previousHandoff)",
    to: "validateContract('sales-auth-handoff', { ...previousHandoff, state: 'ready' })",
    test: 'revoked handoff or lease cannot be revived by retry or a new token',
  },
  {
    id: 'expired_lease',
    file: 'source-grants.ts',
    from: 'lease.expires_at <= now',
    to: 'false',
    test: 'exact retry returns original grant without sliding expiry and expired hash is refused',
  },
];
const run = (name) =>
  spawnSync(
    join(project, 'node_modules/.bin/tsx'),
    ['--test', '--test-reporter=tap', `--test-name-pattern=^${name}$`, testFile],
    {
      cwd: target,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, NODE_ENV: 'test' },
    },
  );
try {
  await mkdir(dirname(target), { recursive: true });
  await cp(join(project, 'src'), join(target, 'src'), { recursive: true });
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'));
  await symlink(join(repo, 'packages'), join(temporary, 'packages'));
  await symlink(join(project, 'node_modules'), join(target, 'node_modules'));
  const baseline = run(
    'canonical source facts rather than claimed summary, recipient or channel determine authorization',
  );
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  const killed = [];
  for (const mutant of mutants) {
    const original = await readFile(join(project, 'src', mutant.file), 'utf8');
    assert.equal(original.split(mutant.from).length, 2, `Mutation anchor changed: ${mutant.id}`);
    const file = join(target, 'src', mutant.file);
    await writeFile(file, original.replace(mutant.from, mutant.to));
    const result = run(mutant.test);
    await writeFile(file, original);
    assert.equal(
      result.status,
      1,
      `${mutant.id} survived or could not run\n${result.stderr}\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes(`not ok 1 - ${mutant.test}`),
      `${mutant.id} did not fail the intended behavior\n${result.stdout}`,
    );
    killed.push(mutant.id);
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      killed,
      scope: 'temporary source copies; no production changes or external mail',
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
