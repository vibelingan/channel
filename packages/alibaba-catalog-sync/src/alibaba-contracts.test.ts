import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  extractProductDetail,
  extractProductListPage,
  isAuthorizationError,
  parseAlibabaApiResponse,
} from './alibaba-contracts.ts';

// Fixtures are CONSTRUCTED from the documented ICBU response shapes
// (docs/accio-alibaba-integration/REPORT.md §3.1). Redacted live fixtures
// replace/confirm them at the MIU 15 gate; the path tables in
// alibaba-contracts.ts are the single place to adjust.

test('success envelope round-trips the lossless tree', () => {
  const envelope = parseAlibabaApiResponse('{"result": {"total_item": 3}}');
  assert.equal(envelope.kind, 'success');
});

test('error envelope surfaces code/message/request id', () => {
  const envelope = parseAlibabaApiResponse(
    '{"error_code": "AppCallLimit", "error_message": "too fast", "request_id": "r-1"}',
  );
  assert.equal(envelope.kind, 'api-error');
  if (envelope.kind === 'api-error') {
    assert.equal(envelope.errorCode, 'AppCallLimit');
    assert.equal(envelope.errorMessage, 'too fast');
    assert.equal(envelope.requestId, 'r-1');
  }
});

test('TOP error envelope surfaces code/message/request id', () => {
  const envelope = parseAlibabaApiResponse(
    '{"type":"ISV","code":"InvalidApiPath","message":"bad path","request_id":"r-top"}',
  );
  assert.deepEqual(envelope, {
    kind: 'api-error',
    errorCode: 'InvalidApiPath',
    errorMessage: 'bad path',
    requestId: 'r-top',
  });
});

test('malformed body is reported, never thrown', () => {
  const envelope = parseAlibabaApiResponse('<html>gateway error</html>');
  assert.equal(envelope.kind, 'malformed');
});

test('authorization errors are classified', () => {
  assert.equal(
    isAuthorizationError(parseAlibabaApiResponse('{"error_code": "IllegalAccessToken"}')),
    true,
  );
  assert.equal(
    isAuthorizationError(parseAlibabaApiResponse('{"error_code": "AppCallLimit"}')),
    false,
  );
});

test('extracts a product list page (documented shape)', () => {
  const envelope = parseAlibabaApiResponse(
    JSON.stringify({
      alibaba_icbu_product_list_response: {
        total_item: 87,
        products: [
          { product_id: 1234567, subject: 'Widget A', gmt_modified: '2026-08-01 10:00:00' },
          { product_id: '2345678', title: 'Widget B' },
          { no_id_here: true },
        ],
      },
    }),
  );
  assert.equal(envelope.kind, 'success');
  if (envelope.kind !== 'success') return;
  const page = extractProductListPage(envelope.root);
  assert.equal(page.totalItems, 87);
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items[0], {
    sourceProductId: '1234567',
    subject: 'Widget A',
    gmtModified: '2026-08-01 10:00:00',
  });
  assert.equal(page.items[1]?.sourceProductId, '2345678');
});

test('extracts the live TOP wrapper around product-list arrays', () => {
  const envelope = parseAlibabaApiResponse(
    JSON.stringify({
      alibaba_icbu_product_list_response: {
        total_item: 3,
        products: {
          alibaba_product_brief_response: [
            {
              product_id: 'AAGGBBhgAOVTpOKZBnRd99iV',
              subject: 'AI Translation Earphones',
              gmt_modified: '2026-01-13 22:28:43',
            },
            { product_id: 'AAEtBBhgAOVTpOKZBnRh_y7a' },
          ],
        },
      },
    }),
  );
  assert.equal(envelope.kind, 'success');
  if (envelope.kind !== 'success') return;
  assert.deepEqual(extractProductListPage(envelope.root), {
    totalItems: 3,
    items: [
      {
        sourceProductId: 'AAGGBBhgAOVTpOKZBnRd99iV',
        subject: 'AI Translation Earphones',
        gmtModified: '2026-01-13 22:28:43',
      },
      { sourceProductId: 'AAEtBBhgAOVTpOKZBnRh_y7a' },
    ],
  });
});

test('list extraction degrades to empty on unknown shapes', () => {
  const envelope = parseAlibabaApiResponse('{"something": "else"}');
  assert.equal(envelope.kind, 'success');
  if (envelope.kind !== 'success') return;
  const page = extractProductListPage(envelope.root);
  assert.equal(page.totalItems, undefined);
  assert.deepEqual(page.items, []);
});

test('extracts product detail with exact money lexemes', () => {
  const envelope = parseAlibabaApiResponse(
    JSON.stringify({
      alibaba_icbu_product_get_response: {
        product: {
          product_id: 987,
          subject: 'Bluetooth Headphones',
          description: '<p>desc</p>',
          category_id: 100200,
          min_order_quantity: 50,
          fob_currency: 'USD',
          fob_min_price: 1.15,
          fob_max_price: 2.5,
          image: {
            images: [
              'https://img.example.alibaba.com/a.jpg',
              { url: 'https://img.example.alibaba.com/b.jpg' },
            ],
          },
          ladder_prices: [
            { min_quantity: 50, price: 2.5 },
            { min_quantity: 500, price: 1.15 },
          ],
          sku_infos: [
            {
              sku_id: 'sku-1',
              price: 2.5,
              available_quantity: 1000,
              attributes: [{ attribute_name: 'Color', attribute_value: 'Black' }],
            },
          ],
          gmt_modified: '2026-08-01 10:00:00',
          status: 'onSelling',
        },
      },
    }),
  );
  assert.equal(envelope.kind, 'success');
  if (envelope.kind !== 'success') return;
  const draft = extractProductDetail(envelope.root);
  assert.equal(draft.sourceProductId, '987');
  assert.equal(draft.subject, 'Bluetooth Headphones');
  assert.equal(draft.categoryId, '100200');
  assert.equal(draft.moqLexeme, '50');
  assert.equal(draft.currencyLexeme, 'USD');
  // The float-trap check: 1.15 must surface as the exact lexeme "1.15".
  assert.equal(draft.fobMinLexeme, '1.15');
  assert.equal(draft.fobMaxLexeme, '2.5');
  assert.deepEqual(draft.imageUrls, [
    'https://img.example.alibaba.com/a.jpg',
    'https://img.example.alibaba.com/b.jpg',
  ]);
  assert.equal(draft.ladderPrices.length, 2);
  assert.deepEqual(draft.ladderPrices[1], { minQuantityLexeme: '500', priceLexeme: '1.15' });
  assert.equal(draft.skus.length, 1);
  assert.deepEqual(draft.skus[0], {
    sourceSkuId: 'sku-1',
    priceLexeme: '2.5',
    availableQuantity: 1000,
    attributes: { Color: 'Black' },
  });
});

test('parses a string fob_price range', () => {
  const envelope = parseAlibabaApiResponse(
    JSON.stringify({
      result: { product: { product_id: 1, fob_price: '1.50-2.30', currency: 'USD' } },
    }),
  );
  assert.equal(envelope.kind, 'success');
  if (envelope.kind !== 'success') return;
  const draft = extractProductDetail(envelope.root);
  assert.equal(draft.fobMinLexeme, '1.50');
  assert.equal(draft.fobMaxLexeme, '2.30');
});

test('detail extraction degrades to an empty draft, never throws', () => {
  const envelope = parseAlibabaApiResponse('{"weird": [1,2,3]}');
  assert.equal(envelope.kind, 'success');
  if (envelope.kind !== 'success') return;
  const draft = extractProductDetail(envelope.root);
  assert.equal(draft.sourceProductId, undefined);
  assert.deepEqual(draft.imageUrls, []);
  assert.deepEqual(draft.skus, []);
});
