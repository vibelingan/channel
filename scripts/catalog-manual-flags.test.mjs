import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
const manual = parse(readFileSync('.github/workflows/seo-site-delivery.yml', 'utf8'));
const normal = parse(readFileSync('.github/workflows/deploy-test.yml', 'utf8'));
const evaluate = (expression, inputs, vars) =>
  Function('inputs', 'vars', `return ${expression.slice(3, -2)}`)(inputs, vars);
test('explicit initial registration and incremental delivery use tracking without changing normal deployment defaults', () => {
  const expression = manual.jobs.site.env.CATALOG_SEO_RECORDING;
  assert.equal(
    evaluate(
      expression,
      { catalog_bootstrap: true, product_source: 'fresh' },
      { CATALOG_SEO_RECORDING: '0' },
    ),
    '1',
  );
  assert.equal(
    evaluate(expression, { catalog_bootstrap: false, product_source: 'refresh' }, {}),
    '1',
  );
  assert.equal(
    evaluate(expression, { catalog_bootstrap: false, product_source: 'fresh' }, {}),
    '0',
  );
  assert.equal(
    evaluate(
      expression,
      { catalog_bootstrap: false, product_source: 'accepted' },
      { CATALOG_SEO_RECORDING: '1' },
    ),
    '1',
  );
  assert.equal(evaluate(normal.jobs.deploy.env.CATALOG_SEO_RECORDING, {}, {}), '0');
  assert.equal(
    evaluate(
      normal.jobs.deploy.env.CATALOG_SEO_RECORDING,
      { catalog_bootstrap: true },
      { CATALOG_SEO_RECORDING: '0' },
    ),
    '0',
  );
});
