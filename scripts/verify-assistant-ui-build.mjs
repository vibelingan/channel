import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'apps/site/dist');
const forbidden = [
  'Component preview · sample data',
  'Local interaction evidence',
  'PREVIEW-001',
  'assistant-preview.html',
];
let checked = 0;
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    assert.notEqual(
      entry.name,
      'assistant-preview.html',
      'Development preview must not be published',
    );
    if (entry.isDirectory()) await visit(filename);
    else if (/\.(?:html|js|json|xml|css)$/.test(entry.name)) {
      const content = await readFile(filename, 'utf8');
      for (const marker of forbidden)
        assert.ok(
          !content.includes(marker),
          `Development marker leaked: ${marker} in ${path.relative(root, filename)}`,
        );
      checked += 1;
    }
  }
}
await visit(output);
assert.ok(checked > 10, 'Build verification needs the complete site output');
console.log(
  JSON.stringify({ checked, development_preview_absent: true, simulated_content_absent: true }),
);
