import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditSourceCategoryCoverage } from './category-coverage.ts';

function observation(id: string, categoryId?: string, provider = 'alibaba', name?: string) {
  return {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider,
      sourceProductKey: id,
      observedAt: '2026-09-04T08:00:00.000Z',
      captureMode: 'full',
      completeness: 'full-product',
    },
    identity: {
      title: `Product ${id}`,
      matchHints: {},
      attributes: [],
      ...(categoryId === undefined
        ? {}
        : {
            category: {
              sourceTaxonomy: 'vendor',
              sourceCategoryId: categoryId,
              ...(name === undefined ? {} : { sourceCategoryName: name }),
            },
          }),
    },
    content: { media: [] },
    lifecycle: { sourceListingStatus: 'unknown' },
    variants: [],
    offers: [],
    evidence: [{ kind: 'source-record', evidenceId: 'evidence' }],
    warnings: [],
  };
}

test('counts non-headphone and missing categories without inventing a website family', () => {
  const result = auditSourceCategoryCoverage([
    observation('1', 'headphone'),
    observation('2', 'fan'),
    observation('3'),
  ]);
  assert.equal(result.validProducts, 3);
  assert.equal(result.missingCategoryIds, 1);
  assert.equal(
    result.categories.reduce((sum, group) => sum + group.productCount, 0),
    3,
  );
  assert.ok(result.categories.some((group) => group.sourceCategoryId === 'fan'));
  assert.equal(JSON.stringify(result).includes('productFamily'), false);
});

test('provider scopes identities and categories; conflicting names stay visible', () => {
  const result = auditSourceCategoryCoverage([
    observation('1', '44', 'alibaba', 'Audio'),
    observation('2', '44', 'alibaba', 'Headphones'),
    observation('1', '44', 'dianxiaomi', 'Accessories'),
  ]);
  assert.equal(result.validProducts, 3);
  assert.equal(result.categories.length, 2);
  assert.deepEqual(result.categories[0]?.sourceCategoryNames, ['Audio', 'Headphones']);
});

test('empty and malformed values are reported, not counted or thrown', () => {
  const result = auditSourceCategoryCoverage(['', null, undefined, [], {}, 1]);
  assert.equal(result.validProducts, 0);
  assert.equal(result.findings.length, 6);
  assert.deepEqual(auditSourceCategoryCoverage([]).categories, []);
});

test('duplicates cannot inflate totals and special ids cannot collide with missing ids', () => {
  const item = observation('1', '__proto__');
  const result = auditSourceCategoryCoverage([
    item,
    item,
    observation('2'),
    observation('3', 'null'),
  ]);
  assert.equal(result.validProducts, 3);
  assert.equal(result.categories.length, 3);
  assert.equal(result.findings[0]?.code, 'duplicate-product-identity');
});

test('output never includes raw evidence, accounts, offers or media URLs', () => {
  const item = observation('1', '44');
  const evidence = item.evidence[0];
  assert.ok(evidence);
  evidence.evidenceId = 'private-evidence-reference';
  const text = JSON.stringify(auditSourceCategoryCoverage([item]));
  assert.equal(text.includes('private-evidence-reference'), false);
  assert.equal(text.includes('sourceProductKey'), false);
});
