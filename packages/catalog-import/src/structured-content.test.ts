import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dianxiaomiObservationAdapter,
  parseDianxiaomiWorkbook,
} from './providers/dianxiaomi/adapter.ts';
import { buildStructuredContent } from './structured-content.ts';
import { buildXlsx } from './testing/xlsx-fixture.ts';

test('source headings and user-confirmed standalone titles become typed blocks, not guessed short prose', () => {
  const result = buildStructuredContent({
    sanitizedHtml:
      '<h2>Technical overview</h2><p>Short prose</p><br>Experienced Headphones Manufacturer<br>Company text<br>Product Description<table><tr><td>Unknown</td><td>Body</td></tr></table>',
  });
  assert.deepEqual(result.noteBlocks, [
    { kind: 'heading', text: 'Technical overview' },
    { kind: 'paragraph', text: 'Short prose' },
    { kind: 'heading', text: 'Experienced Headphones Manufacturer' },
    { kind: 'paragraph', text: 'Company text' },
    { kind: 'heading', text: 'Product Description' },
    { kind: 'paragraph', text: 'Unknown — Body' },
  ]);
  assert.deepEqual(
    result.content?.notes,
    result.noteBlocks?.map((b) => b.text),
  );
});

test('an actual Excel description cell reaches the same structured content contract', () => {
  const workbook = buildXlsx({
    sheets: [
      {
        name: 'Products',
        rows: [
          ['父SKU', 'SKU', '商品标题', '店铺', '商品描述'],
          [
            'P-TABLE',
            'S-TABLE',
            'Table test headset',
            'Fixture shop',
            '<table><tr><td>Material</td><td>ABS</td></tr><tr><td>Package</td><td>AUX cable</td></tr></table>',
          ],
        ],
      },
    ],
  });
  const bundle = parseDianxiaomiWorkbook(workbook).bundle;
  const source = dianxiaomiObservationAdapter.toObservations({
    bundle,
    observedAt: '2026-09-06T00:00:00.000Z',
  }).observations[0];
  assert.ok(source);
  const content = buildStructuredContent(source.content.description).content;
  assert.deepEqual(content?.specifications, [{ name: 'Material', value: 'ABS' }]);
  assert.deepEqual(content?.packaging, [{ name: 'Package', value: 'AUX cable' }]);
});

test('explicit table rows separate specifications packaging and supplier prose', () => {
  const result = buildStructuredContent({
    sanitizedHtml:
      '<p>Experienced Manufacturer</p><table><tr><td>Material</td><td>ABS</td></tr><tr><td>Package</td><td>Power cable and AUX cable</td></tr><tr><td>Our services</td><td>OEM welcome</td></tr></table>',
  });
  assert.deepEqual(result.content, {
    schemaVersion: 'catalog-content-v1',
    specifications: [{ name: 'Material', value: 'ABS' }],
    packaging: [{ name: 'Package', value: 'Power cable and AUX cable' }],
    notes: ['Experienced Manufacturer', 'Our services — OEM welcome'],
  });
});
test('sparse spreadsheet table rows retain explicit cells and decode entities', () => {
  const result = buildStructuredContent({
    sanitizedHtml: '<table><tr><td>Impedance</td><td></td><td>32&#x3a9;</td><td></td></tr></table>',
  });
  assert.deepEqual(result.content, {
    schemaVersion: 'catalog-content-v1',
    specifications: [{ name: 'Impedance', value: '32Ω' }],
    packaging: [],
    notes: [],
  });
});
test('plain prose is never paired into invented facts and unsafe markup cannot execute', () => {
  const result = buildStructuredContent({
    sanitizedHtml: '<p>Material</p><p>ABS</p><script>secret()</script><img src=x onerror=alert(1)>',
  });
  assert.deepEqual(result.content, {
    schemaVersion: 'catalog-content-v1',
    specifications: [],
    packaging: [],
    notes: ['Material', 'ABS'],
  });
});
test('duplicate conflicting fields are demoted rather than silently picking one', () => {
  const result = buildStructuredContent({
    sanitizedHtml:
      '<table><tr><td>Material</td><td>ABS</td></tr><tr><td>material</td><td>Metal</td></tr></table>',
  });
  assert.deepEqual(result.content, {
    schemaVersion: 'catalog-content-v1',
    specifications: [],
    packaging: [],
    notes: ['Material — ABS', 'material — Metal'],
  });
  assert.ok(result.warnings.includes('conflicting-content-field'));
});
test('merged cells and nested tables never produce confident key/value pairs', () => {
  for (const html of [
    '<table><tr><td rowspan="2">Material</td><td>ABS</td></tr></table>',
    '<table><tr><td>Material<table><tr><td>x</td><td>y</td></tr></table></td><td>ABS</td></tr></table>',
  ]) {
    const result = buildStructuredContent({ sanitizedHtml: html });
    assert.ok(result.warnings.includes('ambiguous-table'));
    assert.ok(result.content);
    assert.deepEqual(result.content.specifications, []);
    assert.deepEqual(result.content.packaging, []);
  }
});

test('sanitizer table removal cannot shift ambiguity onto the wrong table', () => {
  const result = buildStructuredContent({
    sanitizedHtml:
      '<form><table><tr><td>old</td><td>discarded</td></tr></table></form><table><tr><td rowspan="2">Material</td><td>ABS</td></tr></table>',
  });
  assert.deepEqual(result.content?.specifications, []);
  assert.ok(result.warnings.includes('ambiguous-table'));
  assert.equal(buildStructuredContent({ placeholder: true, text: '1' }).content, undefined);
});

test('unknown multi-value rows and identical duplicates preserve evidence without extra facts', () => {
  const result = buildStructuredContent({
    sanitizedHtml:
      '<table><tr><td>Material</td><td>ABS</td></tr><tr><td>Material</td><td>ABS</td></tr><tr><td>Impedance</td><td>32Ω</td><td>64Ω</td></tr><tr><td>未知参数</td><td>值</td></tr></table>',
  });
  assert.deepEqual(result.content?.specifications, [{ name: 'Material', value: 'ABS' }]);
  assert.deepEqual(result.content?.notes, ['Impedance — 32Ω — 64Ω', '未知参数 — 值']);
});
test('plain text markup is escaped, and output field limits fail back without truncation', () => {
  assert.deepEqual(
    buildStructuredContent({ text: '<img onerror=alert(1)> plain' }).content?.notes,
    ['<img onerror=alert(1)> plain'],
  );
  assert.equal(
    buildStructuredContent({
      sanitizedHtml: `<table><tr><td>Material</td><td>${'x'.repeat(2001)}</td></tr></table>`,
    }).content,
    undefined,
  );
});
test('null malformed oversized and deep inputs do not throw or fabricate content', () => {
  for (const value of [
    null,
    undefined,
    '',
    [],
    { sanitizedHtml: 42 },
    { sanitizedHtml: 'x'.repeat(64001) },
    { sanitizedHtml: `${'<div>'.repeat(80)}x${'</div>'.repeat(80)}` },
  ])
    assert.equal(buildStructuredContent(value).content, undefined);
  assert.ok(buildStructuredContent({ sanitizedHtml: '<table><tr><td>Material<td>ABS' }).content);
});
