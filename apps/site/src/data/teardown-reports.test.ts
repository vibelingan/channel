import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { teardownBomSource } from '../../../../tests/fixtures/teardown-bom-source.ts';
import { teardownReports } from './teardownReports.ts';

const expectedBomBySlug = new Map(
  teardownBomSource.map(({ slug, rows }) => [
    slug,
    rows.map(({ category, description, cost }) => ({ category, description, cost })),
  ]),
);

test('teardown BOM rows remain faithful to the client source tables', () => {
  assert.equal(teardownBomSource.length, 3);
  assert.equal(teardownBomSource.flatMap(({ rows }) => rows).length, 24);
  for (const { rows } of teardownBomSource) {
    for (const row of rows) {
      assert.notEqual(row.sourceCategory.trim(), '');
      assert.notEqual(row.sourceDescription.trim(), '');
    }
  }
  assert.deepEqual(
    teardownReports.map(({ slug, bomBreakdown }) => ({ slug, bomBreakdown })),
    teardownBomSource.map(({ slug }) => ({
      slug,
      bomBreakdown: expectedBomBySlug.get(slug),
    })),
  );

  for (const report of teardownReports) {
    const total = report.bomBreakdown.at(-1);
    const lineTotalInCents = report.bomBreakdown
      .slice(0, -1)
      .reduce((sum, line) => sum + Math.round(line.cost * 100), 0);
    assert.equal(total?.category, 'Total');
    assert.equal(total.cost, report.estBomCost);
    assert.equal(lineTotalInCents, Math.round(report.estBomCost * 100));
  }
});

test('teardown non-BOM report fields remain unchanged by the fidelity correction', () => {
  for (const report of teardownReports) {
    const { bomBreakdown: _bomBreakdown, ...nonBomReport } = report;
    const baseline = teardownBomSource.find(({ slug }) => slug === report.slug);
    assert.ok(baseline, `missing non-BOM baseline for ${report.slug}`);
    assert.equal(
      createHash('sha256').update(JSON.stringify(nonBomReport)).digest('hex'),
      baseline.nonBomSha256,
      `${report.slug} changed outside bomBreakdown`,
    );
  }
});
