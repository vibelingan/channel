import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { validateCatalogSourceObservation } from '@vibelingan-channel/catalog-import/observations';
import { manageCatalogDetailApproval, setAdapter } from '@vibelingan-channel/db';
import { readCatalogDetailPreview } from '../../functions/admin/src/catalog-detail-preview.ts';
import { prepareCatalogSource } from '../../functions/admin/src/catalog-detail-source.ts';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { fixture } from '../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { getProductDetail } from '../../functions/public-api/src/catalog-detail.ts';
import {
  type DetailPages,
  acceptDetailPage,
  startDetailPages,
} from '../../site/src/catalog/application/catalog-detail-pages.ts';
import {
  matchVariantOptions,
  resolveVariantSelection,
} from '../../site/src/catalog/application/catalog-variant-state.ts';
import { JsonFileAdapter } from './json-adapter.ts';

for (const count of [0, 1, 20, 21, 105]) {
  test(`complete source options survive preview, staged approval, public paging and withdrawal for ${count} configurations`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'channel-options-flow-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'db.json');
    const { product, adapter: input } = fixture(count);
    product.archived = false;
    product.imageIds = ['image-owned'];
    input.rows.images = [
      {
        _id: 'image-owned',
        status: 'active',
        storageProvider: 'local-disk',
        publishedRefCount: 0,
        refCount: 1,
      },
    ];
    const row = input.rows.catalogSourceObservations?.[0];
    assert.ok(row);
    const checked = validateCatalogSourceObservation(row.observation);
    assert.ok(checked.ok);
    const options = [
      { sourceName: 'Color', value: 'Black' },
      { sourceName: 'Color', value: 'White' },
      { sourceName: '10', value: 'Ten' },
      { sourceName: '2', value: 'Two' },
      { sourceName: '__proto__', value: 'ABS' },
      { sourceName: 'constructor', value: 'Metal' },
    ];
    for (const variant of checked.value.variants) variant.options = structuredClone(options);
    row.observation = checked.value;
    writeFileSync(path, JSON.stringify(input.rows));
    let adapter = new JsonFileAdapter(path, true);
    setAdapter(adapter);
    const beforePreview = readFileSync(path, 'utf8');
    const preview = await readCatalogDetailPreview('admin', {
      action: 'preview',
      productId: product._id,
    });
    assert.ok(preview.ok, JSON.stringify(preview));
    assert.equal(readFileSync(path, 'utf8'), beforePreview);
    let prepared = await prepareCatalogSource('admin', {
      action: 'prepare',
      productId: product._id,
    });
    assert.ok(prepared.ok && 'complete' in prepared, JSON.stringify(prepared));
    while (!prepared.complete) {
      const next = await prepareCatalogSource('admin', {
        action: 'prepare',
        productId: product._id,
        page: prepared.nextPage,
      });
      assert.ok(next.ok && 'complete' in next, JSON.stringify(next));
      assert.ok(next.nextPage > prepared.nextPage);
      prepared = next;
    }
    const workflow = (command: unknown) => manageCatalogDetailApproval('admin', command);
    const review = await workflow({
      action: 'review',
      productId: product._id,
      includePreviewMedia: true,
    });
    assert.ok(review.ok && 'detail' in review, JSON.stringify(review));
    assert.deepEqual(
      JSON.parse(JSON.stringify(review.detail)),
      JSON.parse(JSON.stringify(preview.detail)),
    );
    const begun = await workflow({
      action: 'begin',
      command: {
        productId: product._id,
        operationId: randomUUID(),
        expectedDigest: review.expectedDigest,
        expectedRevision: review.expectedRevision,
      },
    });
    assert.ok(begun.ok && 'jobId' in begun, JSON.stringify(begun));
    for (let page = begun.nextPage; page < begun.pages; page++) {
      const staged = await workflow({ action: 'page', jobId: begun.jobId, page });
      assert.ok(staged.ok, JSON.stringify(staged));
      adapter = new JsonFileAdapter(path, true);
      setAdapter(adapter);
    }
    const finished = await workflow({ action: 'finish', jobId: begun.jobId });
    assert.ok(finished.ok, JSON.stringify(finished));
    assert.equal((await adapter.get('products', product._id))?.published, false);
    const config = { jwtSecret: 'options-local-only', enableDetailApproval: true };
    const token = await signSession(config.jwtSecret, {
      sub: 'admin',
      role: 'admin',
      name: 'Admin',
      email: 'admin@example.test',
    });
    const visible = (published: boolean) =>
      handleAdminRequest(
        {
          action: 'update',
          token,
          data: { collection: 'products', id: product._id, values: { published } },
        },
        config,
      );
    const published = await visible(true);
    assert.ok(published.ok, JSON.stringify(published));
    const expectedOptions = options.map(({ sourceName, value }) => ({ name: sourceName, value }));
    const ids = new Set<string>();
    let clientPages: DetailPages | undefined;
    for (let page = 1; page <= Math.max(1, Math.ceil(count / 50)); page++) {
      const detail = await getProductDetail(product._id, page);
      assert.ok(detail.ok, JSON.stringify(detail));
      assert.equal(detail.data.variants.total, count);
      const bytes = Buffer.byteLength(JSON.stringify(detail.data));
      const accepted = clientPages
        ? acceptDetailPage(clientPages, detail.data, bytes)
        : startDetailPages(detail.data, bytes);
      assert.equal(accepted.status, 'ready');
      if (accepted.status !== 'ready') throw new Error('Public client rejected approved detail');
      clientPages = accepted.value;
      for (const variant of detail.data.variants.items) {
        assert.deepEqual(variant.options, expectedOptions);
        ids.add(variant.id);
        const selected = resolveVariantSelection(clientPages, variant.id);
        assert.ok(selected.status === 'selected');
        assert.deepEqual(selected.variant.options, expectedOptions);
      }
      assert.doesNotMatch(
        JSON.stringify(detail),
        /sourceVariantKey|optionValues|detailSourceCandidate/,
      );
    }
    assert.equal(ids.size, count);
    assert.ok(clientPages);
    assert.equal(clientPages.mode, 'complete');
    if (count > 0)
      assert.deepEqual(
        matchVariantOptions(clientPages, [{ name: 'Color', value: 'Black' }]),
        { status: 'identity-required' },
        'conflicting source axes keep the existing truthful direct-ID selection',
      );
    const selected = clientPages.items.at(-1);
    assert.equal(selected !== undefined, count > 0);
    const intent = count > 0 ? 'variant_quote' : 'customization';
    const quoteInput = {
      idempotencyKey: randomUUID(),
      target: {
        intent,
        productId: product._id,
        revision: clientPages.currentPage.revision,
        ...(selected ? { variantId: selected.id } : {}),
      },
      fields: {
        intent,
        quantity: '100',
        deliveryDate: '',
        customizationTypes: count > 0 ? [] : ['logo'],
        brief: count > 0 ? '' : 'Custom logo please.',
        contactName: 'Test Buyer',
        email: 'buyer@example.test',
        company: 'Test Co',
        country: 'HK',
      },
    };
    const quote = await adapter.submitCatalogQuote(quoteInput);
    assert.ok(quote.ok, JSON.stringify(quote));
    assert.deepEqual(await adapter.submitCatalogQuote(quoteInput), quote);
    const inquiry = await adapter.manageCatalogInquiry('admin', {
      action: 'get',
      id: quote.requestId,
    });
    assert.ok(inquiry.ok && inquiry.data.kind === 'detail', JSON.stringify(inquiry));
    assert.equal(inquiry.data.item.snapshot.variant?.id, selected?.id);
    assert.deepEqual(
      inquiry.data.item.snapshot.variant?.options,
      count > 0 ? expectedOptions : undefined,
    );
    const withdrawn = await visible(false);
    assert.ok(withdrawn.ok, JSON.stringify(withdrawn));
    assert.equal((await adapter.get('products', product._id))?.published, false);
    assert.equal((await getProductDetail(product._id)).ok, false);
    assert.equal(
      (await adapter.get('products', product._id))?.productFamily,
      product.productFamily,
    );
    assert.equal(Reflect.get({}, 'polluted'), undefined);
  });
}
