import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildXlsx } from '../../testing/xlsx-fixture.ts';
import { parseDianxiaomiWorkbook } from './adapter.ts';
import { dianxiaomiObservationAdapter } from './observations.ts';

test('Excel cell → sanitizer → grouping → common observation retains image-only descriptions', () => {
  for (const description of [
    '<img src="https://example.com/detail.png">',
    '<p>Safe copy</p><img src="https://example.com/detail.png">',
  ]) {
    const bytes = buildXlsx({
      sheets: [
        {
          name: '全球产品',
          rows: [
            ['父SKU', 'SKU', '商品标题', '店铺', '商品描述', '价格', '库存'],
            ['P-1', 'S-1', 'Source light', 'ShopA_MY', description, '10.00', '5'],
          ],
        },
      ],
    });
    const parsed = parseDianxiaomiWorkbook(bytes);
    const result = dianxiaomiObservationAdapter.toObservations({
      bundle: parsed.bundle,
      storeListings: parsed.storeListings,
      observedAt: '2026-09-10T00:00:00.000Z',
    });
    assert.ok(result.observations.length > 0, JSON.stringify(result.findings));
    for (const observation of result.observations) {
      assert.equal(observation.content.description?.placeholder, false);
      assert.deepEqual(observation.content.description?.imageUrls, [
        'https://example.com/detail.png',
      ]);
      assert.equal(observation.content.media.length, 0, 'description must not become gallery');
    }
  }
});
