import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setAdapter, unfinishedApprovalUsingImage } from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { JsonFileAdapter } from './json-adapter.ts';

for (const place of ['gallery', 'description', 'variant'] as const)
  test(`targeted unfinished hold finds ${place} beyond100unrelated roots without list/fullbody calls`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-target-hold-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'db.json');
    const make = (
      id: string,
    ): {
      _id: string;
      productId: string;
      state: string;
      createdAt: string;
      publication: {
        state: string;
        header: {
          _id: string;
          images: string[];
          descriptionImages: string[];
          descriptionText: string;
        };
        variantImageIds: string[];
      };
      operation: { values: { description: string } };
    } => ({
      _id: id,
      productId: id,
      state: 'staging',
      createdAt: new Date().toISOString(),
      publication: {
        state: 'approved',
        header: { _id: id, images: [], descriptionImages: [], descriptionText: 'target' },
        variantImageIds: [],
      },
      operation: { values: { description: '中'.repeat(1000) } },
    });
    const rows = Array.from({ length: 110 }, (_, i) => make(`unrelated-${i}`));
    const target = make('p');
    if (place === 'gallery') target.publication.header.images = ['/api/images/target'];
    if (place === 'description')
      target.publication.header.descriptionImages = ['/api/images/target'];
    if (place === 'variant') target.publication.variantImageIds = ['target'];
    rows.push(target);
    writeFileSync(file, JSON.stringify({ catalogDetailApprovals: rows }));
    const adapter = new JsonFileAdapter(file);
    adapter.list = async () => {
      throw new Error('Full-body list scan forbidden');
    };
    setAdapter(adapter);
    assert.equal(await unfinishedApprovalUsingImage('target'), 'p');
    assert.equal(await unfinishedApprovalUsingImage('absent'), null);
  });

test('older adapters retain the complete stable-page fallback', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-hold-fallback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  const rows: CollectionDoc[] = Array.from({ length: 110 }, (_, i) => ({
    _id: String(i).padStart(3, '0'),
    productId: 'p',
    state: 'staging',
    createdAt: new Date().toISOString(),
    publication: { state: 'approved', header: { _id: 'p', images: [] } },
  }));
  rows.push({
    _id: '999',
    productId: 'p',
    state: 'staging',
    createdAt: new Date().toISOString(),
    publication: { state: 'approved', header: { _id: 'p', images: ['/api/images/target'] } },
  });
  writeFileSync(file, JSON.stringify({ catalogDetailApprovals: rows }));
  const adapter = new JsonFileAdapter(file);
  Reflect.set(adapter, 'findUnfinishedApprovalUsingImage', undefined);
  const list = adapter.list.bind(adapter);
  let pages = 0;
  adapter.list = async (query) => {
    pages++;
    return list(query);
  };
  setAdapter(adapter);
  assert.equal(await unfinishedApprovalUsingImage('target'), 'p');
  assert.equal(pages, 2);
});
