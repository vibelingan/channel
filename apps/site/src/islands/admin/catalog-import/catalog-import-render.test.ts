/**
 * Presentational tests for the Catalog Import preview.
 *
 * The assertions worth having here are the ones about MEANING, not markup: a
 * CNY price must never render as a bare number on a page that also shows USD
 * elsewhere, a stock figure the shops disagree about must never render as a
 * number at all, and the merchant's own HTML must never reach the DOM.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogImportFindings } from './CatalogImportFindings.tsx';
import { CatalogImportProductTable } from './CatalogImportProductTable.tsx';
import { CatalogImportSummary } from './CatalogImportSummary.tsx';
import {
  formatInventory,
  formatSourceMoney,
  toJobView,
  toProductView,
} from './catalog-import-api.ts';

function itemDoc(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: 'job#dianxiaomi:p-1',
    jobId: 'job',
    status: 'valid',
    parentSku: 'P-1',
    title: 'Bluetooth earbuds',
    sourceListingStatus: 'draft',
    variantCount: 1,
    candidate: {
      identity: { provider: 'dianxiaomi', sourceProductKey: 'dianxiaomi:p-1' },
      parentSku: 'P-1',
      title: 'Bluetooth earbuds',
      descriptionText: 'Real description',
      media: [{ sourceUrl: 'https://cdn.example/a.jpg', role: 'primary', position: 0 }],
      variants: [
        {
          identity: { provider: 'dianxiaomi', sourceVariantKey: 'dianxiaomi:s-1' },
          sku: 'S-1',
          optionValues: { Color: 'Black' },
          sourceRegularPrice: { amountMinor: 129900, currency: 'CNY' },
          inventory: [],
          media: [],
        },
      ],
      sourceListingStatus: 'draft',
      attributes: {},
      matchHints: {},
    },
    storeListings: [
      {
        rowNumber: 12,
        storeKey: 'LingAn_MY',
        sku: 'S-1',
        sourceListingStatus: 'draft',
        sourceRegularPrice: { amountMinor: 129900, currency: 'CNY' },
        quantity: 40,
      },
      {
        rowNumber: 13,
        storeKey: 'LingAn_SG',
        sku: 'S-1',
        sourceListingStatus: 'published',
        externalProductId: 'LZD000001',
        sourceRegularPrice: { amountMinor: 139900, currency: 'CNY' },
        quantity: 40,
      },
    ],
    inventory: [
      {
        candidateSkuKey: 'dianxiaomi:s-1',
        resolution: {
          state: 'known',
          quantity: 40,
          snapshots: [{ quantity: 40 }, { quantity: 40 }],
        },
      },
    ],
    findings: [],
    ...overrides,
  } as CollectionDoc;
}

const renderTable = (docs: CollectionDoc[]) =>
  renderToStaticMarkup(
    createElement(CatalogImportProductTable, { products: docs.map(toProductView) }),
  );

// --- money ------------------------------------------------------------------

test('source money always renders with its currency attached', () => {
  assert.equal(formatSourceMoney({ amountMinor: 129900, currency: 'CNY' }), 'CNY 1,299.00');
  assert.equal(formatSourceMoney({ amountMinor: 1, currency: 'CNY' }), 'CNY 0.01');
  assert.equal(formatSourceMoney({ amountMinor: 0, currency: 'CNY' }), 'CNY 0.00');
  assert.equal(formatSourceMoney(null), '—');
});

test('the preview labels its prices as source CNY in words, above the numbers', () => {
  const markup = renderToStaticMarkup(
    createElement(CatalogImportSummary, {
      job: toJobView({
        _id: 'job',
        provider: 'dianxiaomi',
        status: 'previewReady',
        sourceFileName: 'export.xlsx',
        sourceFileSha256: 'a'.repeat(64),
        sourceStorageFileId: 'cloud://private/import.xlsx',
        counts: { rows: 312, parentSkus: 77, skus: 289 },
        summary: { products: 77, variants: 289, errors: 0 },
      } as CollectionDoc),
    }),
  );
  assert.ok(markup.includes('source CNY'));
  assert.ok(markup.includes('USD website prices are not'));
  assert.ok(markup.includes('312'));
  assert.ok(markup.includes('289'));
  assert.ok(markup.includes('exact workbook is retained as private source evidence'));
  assert.ok(!markup.includes('workbook itself is not stored'));
});

test('a failed evidence write does not claim the workbook was retained', () => {
  const markup = renderToStaticMarkup(
    createElement(CatalogImportSummary, {
      job: toJobView({
        _id: 'failed-job',
        provider: 'dianxiaomi',
        status: 'failed',
        failureCode: 'source-evidence-write-failed',
        sourceFileName: 'export.xlsx',
        sourceFileSha256: 'b'.repeat(64),
      } as CollectionDoc),
    }),
  );
  assert.ok(markup.includes('exact workbook is not available'));
  assert.ok(!markup.includes('exact workbook is retained as private source evidence'));
});

test('a failed evidence attachment with successful cleanup reports the workbook absent', () => {
  const markup = renderToStaticMarkup(
    createElement(CatalogImportSummary, {
      job: toJobView({
        _id: 'cleaned-up-job',
        provider: 'dianxiaomi',
        status: 'failed',
        failureCode: 'source-evidence-attach-failed',
        sourceFileName: 'export.xlsx',
        sourceFileSha256: 'c'.repeat(64),
      } as CollectionDoc),
    }),
  );
  assert.ok(markup.includes('exact workbook is not available'));
  assert.ok(!markup.includes('exact workbook is retained as private source evidence'));
});

test('a legacy job without evidence metadata reports retention as unconfirmed', () => {
  const markup = renderToStaticMarkup(
    createElement(CatalogImportSummary, {
      job: toJobView({
        _id: 'legacy-job',
        provider: 'dianxiaomi',
        status: 'failed',
        sourceFileName: 'export.xlsx',
        sourceFileSha256: 'd'.repeat(64),
      } as CollectionDoc),
    }),
  );
  assert.ok(markup.includes('workbook retention could not be confirmed'));
  assert.ok(!markup.includes('exact workbook is retained as private source evidence'));
});

// --- inventory --------------------------------------------------------------

test('an agreed stock figure renders as the number, once', () => {
  assert.deepEqual(formatInventory({ state: 'known', quantity: 40 }), {
    label: '40',
    conflict: false,
  });
  const markup = renderTable([itemDoc()]);
  assert.ok(markup.includes('>40<'));
  // 80 would be the sum of the two shop lines; it must appear nowhere.
  assert.equal(markup.includes('>80<'), false);
});

test('a disputed stock figure renders as a conflict, never as a number', () => {
  assert.deepEqual(formatInventory({ state: 'conflict', quantities: [12, 40] }), {
    label: 'conflicting (12, 40)',
    conflict: true,
  });
  const markup = renderTable([
    itemDoc({
      inventory: [
        {
          candidateSkuKey: 'dianxiaomi:s-1',
          resolution: { state: 'conflict', quantities: [12, 40], snapshots: [] },
        },
      ],
    }),
  ]);
  assert.ok(markup.includes('conflicting (12, 40)'));
  assert.ok(markup.includes('text-rose-700'), 'a conflict is visually obvious');
});

test('unknown inventory says so rather than showing zero', () => {
  assert.deepEqual(formatInventory({ state: 'unknown' }), { label: 'unknown', conflict: false });
  assert.deepEqual(formatInventory(undefined), { label: 'unknown', conflict: false });
  const markup = renderTable([itemDoc({ inventory: [] })]);
  assert.ok(markup.includes('unknown'));
});

// --- provenance -------------------------------------------------------------

test('each shop line keeps its own price, status and marketplace id', () => {
  const markup = renderTable([itemDoc()]);
  assert.ok(markup.includes('LingAn_MY'));
  assert.ok(markup.includes('LingAn_SG'));
  assert.ok(markup.includes('CNY 1,299.00'));
  assert.ok(markup.includes('CNY 1,399.00'));
  assert.ok(markup.includes('LZD000001'));
  assert.ok(markup.includes('>12<'), 'the source row number is shown');
});

test('a source-draft product is shown as eligible rather than as a problem', () => {
  const markup = renderTable([itemDoc()]);
  assert.ok(markup.includes('source: draft'));
  assert.ok(markup.includes('still eligible here'));
});

test('a rejected item is visually obvious', () => {
  const markup = renderTable([itemDoc({ status: 'rejected' })]);
  assert.ok(markup.includes('rejected'));
  assert.ok(markup.includes('bg-rose-100'));
});

// --- safety -----------------------------------------------------------------

test('merchant HTML never reaches the DOM', () => {
  const hostile = itemDoc({
    title: '<img src=x onerror=alert(1)>',
    candidate: {
      ...(itemDoc().candidate as Record<string, unknown>),
      descriptionText: '<script>alert(1)</script> plain words',
      descriptionHtml: '<script>alert(1)</script>',
    },
  });
  const markup = renderTable([hostile]);
  // The property is that no LIVE element can be assembled from supplier input,
  // not that the characters never appear: React escapes `<` and `>` but not
  // `=`, so the inert text `onerror=alert(1)` is expected to show up while no
  // element carrying it does. The component also reads descriptionText and
  // never descriptionHtml, so the sanitized markup is stored, not rendered.
  assert.equal(/<script/i.test(markup), false, 'no live script element');
  assert.equal(/<img[^>]*onerror/i.test(markup), false, 'no live element with a handler');
  assert.equal(/<[a-z][^>]*\son[a-z]+\s*=/i.test(markup), false, 'no event handler attribute');
  assert.ok(markup.includes('&lt;script&gt;'), 'the merchant text is shown, escaped');
  assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the title is inert text');
  assert.ok(markup.includes('plain words'));
});

test('source images are requested without a referrer', () => {
  const markup = renderTable([itemDoc()]);
  assert.ok(
    markup.includes('referrerPolicy="no-referrer"') ||
      markup.includes('referrerpolicy="no-referrer"'),
  );
  assert.ok(markup.includes('https://cdn.example/a.jpg'));
});

test('a product with no usable description says so instead of showing filler', () => {
  const markup = renderTable([
    itemDoc({
      candidate: {
        ...(itemDoc().candidate as Record<string, unknown>),
        descriptionText: undefined,
      },
    }),
  ]);
  assert.ok(markup.includes('No usable source description'));
});

// --- findings ---------------------------------------------------------------

test('repeated findings collapse to one line with a count', () => {
  const markup = renderToStaticMarkup(
    createElement(CatalogImportFindings, {
      findings: [
        {
          severity: 'warning' as const,
          code: 'DESCRIPTION_PLACEHOLDER',
          message: 'Description contains only placeholder markup.',
          rowNumber: 4,
          sku: 'S-1',
        },
        {
          severity: 'warning' as const,
          code: 'DESCRIPTION_PLACEHOLDER',
          message: 'Description contains only placeholder markup.',
          rowNumber: 5,
          sku: 'S-2',
        },
        {
          severity: 'error' as const,
          code: 'INVENTORY_CONFLICT',
          message: 'Stores report different stock.',
          rowNumber: 6,
          sku: 'S-3',
        },
      ],
    }),
  );
  assert.ok(markup.includes('DESCRIPTION_PLACEHOLDER'));
  assert.ok(markup.includes('×2'));
  assert.ok(markup.includes('INVENTORY_CONFLICT'));
  assert.ok(markup.includes('bg-rose-50'), 'errors read differently from warnings');
});

test('no findings renders nothing at all', () => {
  assert.equal(renderToStaticMarkup(createElement(CatalogImportFindings, { findings: [] })), '');
});
