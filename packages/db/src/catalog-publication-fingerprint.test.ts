import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { publicationContentFingerprint } from './catalog-publication-fingerprint.ts';

const product = (owner: string, extra: Record<string, unknown> = {}): CollectionDoc => ({
  _id: 'p1',
  name: 'Headset',
  detailSourceOwner: owner,
  skuCode: 'KH-01',
  series: 'S1',
  modName: 'M1',
  modType: 'Over-ear',
  ...extra,
});

test('a manual product: editing a spec field after approval changes the fingerprint (MIU-29)', () => {
  for (const field of ['skuCode', 'series', 'modName', 'modType']) {
    assert.notEqual(
      publicationContentFingerprint(product('manual:p1', { [field]: 'edited' })),
      publicationContentFingerprint(product('manual:p1')),
      field,
    );
  }
});

test('a synced product: spec fields stay out, so every existing receipt still matches', () => {
  const linked = product('alibaba:source-a');
  assert.equal(
    publicationContentFingerprint({ ...linked, series: 'edited' }),
    publicationContentFingerprint(linked),
  );
  // The pre-change fingerprint of a synced product, recomputed by hand.
  const { skuCode: _s, series: _r, modName: _m, modType: _t, ...withoutSpec } = linked;
  assert.equal(publicationContentFingerprint(linked), publicationContentFingerprint(withoutSpec));
});
