import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const adminSelectFiles = {
  './RecordForm.tsx': 1,
  './QuantityTierPricingEditor.tsx': 1,
  './CollectionView.tsx': 3,
  './FilterBuilder.tsx': 4,
} as const;

test('all Admin single-select surfaces use the shared Select component', () => {
  const adminDirectory = fileURLToPath(new URL('.', import.meta.url));
  const tsxFiles = readdirSync(adminDirectory, { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.tsx'))
    .filter((entry) => !entry.endsWith('.test.tsx'));

  for (const relativePath of tsxFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /<select\b/, `${relativePath} must not render a raw select`);
  }

  for (const [relativePath, expectedUsageCount] of Object.entries(adminSelectFiles)) {
    const filePath = fileURLToPath(new URL(relativePath, import.meta.url));
    const source = readFileSync(filePath, 'utf8');
    assert.match(source, /from ['"]\.\.\/\.\.\/components\/form\/Select\.tsx['"]/);
    assert.equal(
      source.match(/<Select\b/g)?.length,
      expectedUsageCount,
      `${relativePath} must keep every migrated shared Select surface`,
    );
  }
});
