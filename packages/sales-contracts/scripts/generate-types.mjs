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
const schemas = {};
for (const kind of kinds) {
  const schema = JSON.parse(
    await readFile(new URL(`../schemas/${kind}.schema.json`, import.meta.url), 'utf8'),
  );
  schemas[kind] = schema;
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
const schemaTarget = new URL('../src/schemas.generated.ts', import.meta.url);
const schemaOutput = `${banner}export const CONTRACT_SCHEMAS = ${JSON.stringify(schemas, null, 2)};\n`;
for (const [file, content] of [
  [target, output],
  [schemaTarget, schemaOutput],
]) {
  if (process.argv.includes('--check')) {
    if ((await readFile(file, 'utf8')) !== content)
      throw new Error('Generated contracts drifted; run pnpm generate');
  } else await writeFile(file, content);
}
