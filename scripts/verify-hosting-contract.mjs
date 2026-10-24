import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { auditHostingContract, hostingContractHashes } from './hosting-contract.mjs';

const { values } = parseArgs({
  options: {
    site: { type: 'string' },
    dist: { type: 'string' },
    report: { type: 'string' },
  },
});
if (!values.site || !values.report)
  throw new Error(
    'Usage: node scripts/verify-hosting-contract.mjs --site <origin> --report <json> [--dist <accepted-dist>]',
  );
const report = await auditHostingContract(values.site, {
  expectedHashes: values.dist ? hostingContractHashes(values.dist) : {},
});
await mkdir(dirname(values.report), { recursive: true });
await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Hosting contract: ${report.checks.filter((check) => check.passed).length}/${report.checks.length} passed; ${values.report}`,
);
if (!report.passed) process.exitCode = 1;
