import { writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { planHostingRecovery } from './hosting-recovery.mjs';
import { readJson } from './release/input.mjs';

const { values } = parseArgs({
  options: Object.fromEntries(
    ['manifest', 'directory', 'env', 'site', 'current-owned', 'public-products', 'report'].map(
      (key) => [key, { type: 'string' }],
    ),
  ),
});
for (const key of [
  'manifest',
  'directory',
  'env',
  'site',
  'current-owned',
  'public-products',
  'report',
]) {
  if (!values[key])
    throw new Error(
      `Missing --${key}. This command prepares a plan and never writes to the cloud.`,
    );
}
const read = (file) => readJson(dirname(resolve(file)), basename(file));
const plan = planHostingRecovery({
  manifest: read(values.manifest),
  directory: values.directory,
  target: { envId: values.env, site: values.site },
  currentOwnedPaths: read(values['current-owned']),
  publicProductPaths: read(values['public-products']),
});
writeFileSync(values.report, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
console.log(
  `Prepared ${plan.uploads.length} uploads and ${plan.deletes.length} exact removals. No cloud writes.`,
);
