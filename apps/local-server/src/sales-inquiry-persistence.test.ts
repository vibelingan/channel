import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { JsonFileAdapter } from './json-adapter.ts';
import { createWebsiteFixture } from '../../functions/sales-integration/src/website-test-fixtures.ts';

test('local file adapter persists the same source registrations across reopen and never backfills a retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-sales-local-'));
  try {
    const fixture = createWebsiteFixture();
    const file = join(directory, 'db.json');
    const initial: Record<string, CollectionDoc[]> = {};
    for (const [key, row] of fixture.rows) {
      const collection = key.slice(0, key.indexOf('/'));
      initial[collection] ??= [];
      initial[collection].push(row);
    }
    await writeFile(file, JSON.stringify(initial));
    const adapter = new JsonFileAdapter(file, true);
    const prior = fixture.quoteInput();
    assert.ok((await adapter.submitCatalogQuote(prior)).ok);
    assert.ok((await adapter.submitCatalogQuote(prior, fixture.scope)).ok);
    const future=await adapter.submitCatalogQuote(fixture.quoteInput(),{...fixture.scope,cutover_at:Math.floor(Date.now()/1000)+3600});
    assert.ok(future.ok);
    assert.equal((await adapter.get('catalogQuoteRequests',future.requestId))?.client_id,undefined);
    const fresh = fixture.quoteInput();
    const product = await adapter.submitCatalogQuote(fresh, fixture.scope);
    assert.ok(product.ok);
    const oem = await adapter.saveFinalizedSalesOemSubmission(
      {
        projectId: 'local_oem',
        projectData: {
          company: 'Buyer',
          contact: 'Alex',
          email: 'buyer@example.invalid',
          status: 'new',
          category: 'Headphones',
          quantity: 500,
        },
      },
      fixture.scope,
    );
    assert.equal(oem.salesSubmissionState, 'finalized');
    const disk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(disk.channelSalesSourceRegistrations.length, 2);
    const reopened = new JsonFileAdapter(file, true);
    assert.equal(
      (await reopened.get('catalogQuoteRequests', product.requestId))?.salesSubmissionState,
      'finalized',
    );
    assert.equal(
      (await reopened.get('oemProjects', 'local_oem'))?.salesSubmittedRevision,
      oem.salesSubmittedRevision,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
