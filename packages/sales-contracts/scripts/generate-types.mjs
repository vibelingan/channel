import { readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';

const kinds = [
  'inquiry',
  'mail-snapshot',
  'control-command',
  'approval',
  'run-context',
  'client-bindings',
];
const banner = '// Generated from schemas/*.schema.json. Run pnpm generate; do not edit.\n';
const parts = [];
for (const kind of kinds) {
  const schema = JSON.parse(
    await readFile(new URL(`../schemas/${kind}.schema.json`, import.meta.url), 'utf8'),
  );
  parts.push(
    await compile(schema, schema.title, {
      bannerComment: '',
      additionalProperties: false,
      format: true,
      maxItems: -1,
    }),
  );
}
const output = banner + parts.join('\n');
const target = new URL('../src/types.generated.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== output)
    throw new Error('Generated contract types drifted; run pnpm generate');
} else await writeFile(target, output);
