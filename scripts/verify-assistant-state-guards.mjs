import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'apps/site/src/islands/ai/assistant');
const original = await readFile(path.join(sourceDir, 'state.ts'), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const variants = [
 ['turn identity', "if (event.conversationKey !== state.conversationKey || event.turnKey !== turn.request.turnKey) return state;", 'if (false) return state;', 'foreign conversation and old turn events cannot modify current answer'],
 ['sequence deduplication', 'event.sequence <= turn.cursor || ', '', 'duplicate event cannot append the same token twice'],
 ['terminal fence', ' || terminal(turn.phase)', '', 'terminal answers ignore late text even with a newer sequence'],
 ['unconfirmed stop', "case 'stop_unknown': return { ...state, turn: { ...turn, phase: 'stop_unknown' } };", "case 'stop_unknown': return { ...state, turn: { ...turn, phase: 'stopped' } };", 'requesting stop and uncertain acknowledgement never pretend the answer stopped'],
];
const temporary = await mkdtemp(path.join(tmpdir(), 'assistant-guards-'));
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error('--output requires a path');
const output = outputIndex < 0 ? path.join(root, 'output/assistant-ui/guards.json') : process.argv[outputIndex + 1];
const report = { scope: 'targeted frontend reducer guards; disposable source copy; no browser/backend authority claim', source_sha256: sha(original), baseline: null, mutants: [], source_unchanged: false };
try {
 await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ type: 'module' }));
 for (const file of ['model.ts', 'state.test.ts']) await writeFile(path.join(temporary, file), await readFile(path.join(sourceDir, file)));
 const run = () => spawnSync(process.execPath, [path.join(root, 'apps/site/node_modules/tsx/dist/cli.mjs'), '--test', '--test-reporter=tap', path.join(temporary, 'state.test.ts')], { cwd: root, encoding: 'utf8', timeout: 15000 });
 await writeFile(path.join(temporary, 'state.ts'), original);
 const baseline = run(); report.baseline = { status: baseline.status, passed: baseline.status === 0 };
 if (baseline.status !== 0) throw new Error('Clean baseline failed');
 for (const [name, before, after, testName] of variants) {
  if (original.split(before).length !== 2) throw new Error('Mutation anchor must be unique: '+name);
  await writeFile(path.join(temporary, 'state.ts'), original.replace(before, after));
  const result = run();
  const intended = result.stdout?.includes(' - '+testName+'\n') && result.stdout?.includes("code: 'ERR_ASSERTION'") && result.stdout?.split('\n').some(line => line.startsWith('not ok ') && line.endsWith(' - '+testName));
  report.mutants.push({ name, test: testName, mutant_sha256: sha(original.replace(before, after)), outcome: result.error ? 'invalid' : result.status !== 0 && intended ? 'killed' : result.status === 0 ? 'survived' : 'invalid' });
 }
 report.source_unchanged = sha(await readFile(path.join(sourceDir, 'state.ts'))) === report.source_sha256;
} finally {
 await rm(temporary, { recursive: true, force: true });
 await mkdir(path.dirname(output), { recursive: true });
 await writeFile(output, JSON.stringify(report, null, 2)+'\n');
}
console.log(JSON.stringify(report));
if (!report.source_unchanged || report.mutants.some(item => item.outcome !== 'killed')) process.exitCode = 1;
