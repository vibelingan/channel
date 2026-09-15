/** Offline, read-only calibration. Input is an array of normalized observations. */
import { readFile, stat } from 'node:fs/promises';
import { auditSourceCategoryCoverage } from './category-coverage.ts';

async function main() {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length > 0) throw new Error('Usage: audit:categories <observations.json>');
  if ((await stat(path)).size > 50 * 1024 * 1024) throw new Error('Snapshot exceeds 50 MiB limit');
  const input: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(input)) throw new Error('Expected an array of normalized observations');
  const report = auditSourceCategoryCoverage(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.findings.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  // Do not echo JSON parser messages: they can contain private input fragments.
  process.stderr.write(
    error instanceof SyntaxError
      ? 'Invalid JSON snapshot\n'
      : 'Category audit failed; check file path, size and root array shape\n',
  );
  process.exitCode = 1;
});
