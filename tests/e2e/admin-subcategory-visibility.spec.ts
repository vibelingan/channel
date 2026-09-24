import { type Locator, type Page, expect, test } from '@playwright/test';
import type { ProductFamily } from '../../packages/shared/src/catalog-product.ts';
import {
  type CatalogClassificationAssignmentRequest,
  CatalogClassificationAssignmentResultSchema,
  type CatalogTaxonomy,
  type CatalogTaxonomyCommand,
  CatalogTaxonomyResultSchema,
} from '../../packages/shared/src/catalog-taxonomy.ts';
import type { CollectionDoc } from '../../packages/shared/src/collections.ts';
import { type ListResult, adminAction, loginAdmin } from './helpers/admin-api';
import {
  e2e,
  requireAdminCredentialsWhenEnabled,
  requireCatalogLocalSeedWhenEnabled,
} from './helpers/env';

const enabled = e2e.catalogLocalSeed;
// @skip-when outside the disposable local runner; CI runs this lane with owned DB and synthetic credentials, whose absence then throws below.
test.skip(!enabled, 'Run through the disposable catalog-admin-local runner, never a live site.');
requireCatalogLocalSeedWhenEnabled(enabled);
requireAdminCredentialsWhenEnabled(enabled, 'local admin subcategory journey');
if (
  enabled &&
  (!e2e.allowMutation || e2e.adminEmail !== 'admin@channel.local' || e2e.adminPassword !== 'admin')
) {
  throw new Error('Admin subcategories require the runner mutation opt-in and local credentials.');
}
test.describe.configure({ mode: 'serial', retries: 0 });

const marker = `${e2e.runId} Admin subcategory`;

async function choose(scope: Locator | Page, label: string, option: string) {
  await scope
    .getByRole('combobox', { name: label, exact: true })
    .and(scope.locator('button'))
    .click();
  await scope
    .getByRole('listbox', { name: label, exact: true })
    .getByRole('option', { name: option, exact: true })
    .click();
}

test('local admin subcategories: saved names, scoped filter, pagination and read-only summary', async ({
  page,
  request,
}, info) => {
  test.setTimeout(240_000);
  const health = await request.get(`${e2e.apiUrl}/api/health`);
  expect(health.ok()).toBe(true);
  const healthBody: { data?: { mode?: unknown; db?: unknown } } = await health.json();
  expect(healthBody.data?.mode).toBe('local');
  expect(healthBody.data?.db).toBe(e2e.catalogLocalDb);
  const session = await loginAdmin(request);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const readProduct = (id: string) =>
    adminAction<CollectionDoc>(request, 'get', { collection: 'products', id }, session.token);
  async function taxonomy(command: CatalogTaxonomyCommand): Promise<CatalogTaxonomy> {
    const result = CatalogTaxonomyResultSchema.parse(
      await adminAction<unknown>(request, 'catalogCategories', command, session.token),
    );
    if (!('registry' in result)) throw new Error(`Taxonomy ${command.operation}: ${result.status}`);
    return result.registry;
  }
  const saveTaxonomy = (registry: CatalogTaxonomy) =>
    taxonomy({
      kind: 'taxonomy',
      operation: 'save',
      family: registry.family,
      expectedRevision: registry.revision,
      name: registry.name,
      children: registry.children,
    });
  async function create(family: ProductFamily, index: number, extra: Record<string, unknown> = {}) {
    return adminAction<CollectionDoc>(
      request,
      'create',
      {
        collection: 'products',
        values: {
          name: `${marker} ${family} ${String(index).padStart(2, '0')}`,
          productFamily: family,
          description: 'Disposable local admin subcategory acceptance product.',
          published: false,
          archived: false,
          ...extra,
        },
      },
      session.token,
    );
  }
  async function assign(registry: CatalogTaxonomy, ids: string[], subcategoryIds: string[]) {
    for (let start = 0; start < ids.length; start += 20) {
      const batch = ids.slice(start, start + 20);
      const products = await Promise.all(batch.map(readProduct));
      const command: CatalogClassificationAssignmentRequest = {
        kind: 'assignment',
        operation: subcategoryIds.length ? 'replace' : 'clear',
        family: registry.family,
        taxonomyRevision: registry.revision,
        subcategoryIds,
        products: products.map((product) => {
          if (typeof product.updatedAt !== 'string') throw new Error('Missing product revision');
          return { productId: product._id, expectedUpdatedAt: product.updatedAt };
        }),
      };
      const result = CatalogClassificationAssignmentResultSchema.parse(
        await adminAction<unknown>(request, 'catalogCategories', command, session.token),
      );
      expect(result.results).toEqual(batch.map((productId) => ({ productId, status: 'saved' })));
    }
  }
  async function rawList(data: Record<string, unknown>) {
    const response = await request.post(`${e2e.apiUrl}/api/admin`, {
      data: { action: 'list', data, token: session.token },
    });
    return (await response.json()) as {
      ok: boolean;
      data?: ListResult<CollectionDoc>;
      error?: { code: string };
    };
  }

  const initialToys = await taxonomy({ kind: 'taxonomy', operation: 'read', family: 'toys' });
  const blocks = {
    id: `${e2e.runId}-toys-blocks`,
    name: `Blocks ${e2e.runId}`,
    slug: `${e2e.runId}-toys-blocks`,
    order: initialToys.children.length,
    status: 'active' as const,
  };
  const puzzles = {
    ...blocks,
    id: `${e2e.runId}-toys-puzzles`,
    name: `Puzzles ${e2e.runId}`,
    slug: `${e2e.runId}-toys-puzzles`,
    order: initialToys.children.length + 1,
  };
  let toys = await saveTaxonomy({
    ...initialToys,
    children: [...initialToys.children, blocks, puzzles],
  });

  // Default admin order is newest first; create the inspected rows last so they stay on page 1.
  const blocksOnly: CollectionDoc[] = [];
  for (let index = 4; index <= 25; index++) blocksOnly.push(await create('toys', index));
  const both = await create('toys', 1);
  const cleared = await create('toys', 2);
  const unassigned = await create('toys', 3);
  const legacy = await create('headphones', 1, { category: 'office' });
  await assign(toys, [both._id], [blocks.id, puzzles.id]);
  await assign(toys, [cleared._id], []);
  await assign(
    toys,
    blocksOnly.map((product) => product._id),
    [blocks.id],
  );
  toys = await saveTaxonomy({
    ...toys,
    children: toys.children.map((child) =>
      child.id === puzzles.id ? { ...child, status: 'archived' } : child,
    ),
  });

  await test.step('server scopes, validates and pages the filter', async () => {
    const scoped = await rawList({
      collection: 'products',
      productFamily: 'toys',
      subcategoryIds: [blocks.id],
      search: marker,
      page: 2,
      pageSize: 20,
    });
    expect(scoped.ok).toBe(true);
    expect(scoped.data).toMatchObject({ total: 23, page: 2 });
    expect(scoped.data?.items).toHaveLength(3);
    const archived = await rawList({
      collection: 'products',
      productFamily: 'toys',
      subcategoryIds: [puzzles.id],
      search: marker,
    });
    expect(archived.data?.items.map((item) => item._id)).toEqual([both._id]);
    for (const data of [
      { collection: 'products', subcategoryIds: [blocks.id] },
      { collection: 'products', productFamily: 'misc', subcategoryIds: [blocks.id] },
      { collection: 'products', productFamily: 'toys', subcategoryIds: ['headphones-office'] },
    ]) {
      expect((await rawList(data)).error?.code).toBe('BAD_REQUEST');
    }
  });

  const tracked = [both, cleared, unassigned, legacy, ...blocksOnly.slice(0, 2)];
  const revisions = async () =>
    (await Promise.all(tracked.map((product) => readProduct(product._id)))).map(
      (product) => product.updatedAt,
    );
  const before = await revisions();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(
    ({ session, origin }) => {
      if (window.location.origin !== origin) return;
      localStorage.setItem('channel.token', session.token);
      localStorage.setItem('channel.user', JSON.stringify(session.user));
    },
    { session, origin: new URL(e2e.siteUrl).origin },
  );
  const rowFor = (product: CollectionDoc) =>
    page.getByRole('row').filter({ has: page.getByText(String(product.name), { exact: true }) });
  const subcategoriesOf = (product: CollectionDoc) =>
    rowFor(product).locator('[data-subcategory-state]');
  const records = page.getByText(/^\d+ records?$/);
  const subcategoryTrigger = page
    .getByRole('combobox', { name: 'Website subcategory', exact: true })
    .and(page.locator('button'));
  // A pending-review badge appends "N new product(s) to review" to the tab name.
  const familyTab = (label: string) =>
    page
      .getByRole('group', { name: 'Product family', exact: true })
      .getByRole('button', { name: new RegExp(`^${label}(?: \\d+ new products? to review)?$`) });
  async function searchProducts() {
    await page.getByPlaceholder(/^Search name/).fill(marker);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
  }

  await test.step('list shows saved website subcategory names, not legacy scalars', async () => {
    await page.goto('/admin?productFamily=toys');
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    await searchProducts();
    await expect(page.getByRole('columnheader', { name: 'Website subcategories' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Headphone type' })).toHaveCount(0);
    await expect(records).toHaveText('25 records');
    await expect(subcategoriesOf(both)).toHaveText(`${blocks.name}, ${puzzles.name} (archived)`);
    await expect(subcategoriesOf(cleared)).toHaveText('None');
    await expect(subcategoriesOf(unassigned)).toHaveText('None');
    await page.screenshot({ path: info.outputPath('toys-list-1440.png'), fullPage: true });
  });

  await test.step('filter scopes counts and pagination and survives reload and history', async () => {
    await choose(page, 'Website subcategory', blocks.name);
    await expect(page).toHaveURL(new RegExp(`subcategory=${blocks.id}`));
    await expect(records).toHaveText('23 records');
    await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
    await expect(rowFor(unassigned)).toHaveCount(0);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select row', exact: true })).toHaveCount(3);

    await choose(page, 'Website subcategory', `${puzzles.name} (archived)`);
    await expect(records).toHaveText('1 record');
    await expect(page.getByText('1 / 1', { exact: true })).toBeVisible();
    await expect(subcategoriesOf(both)).toHaveText(`${blocks.name}, ${puzzles.name} (archived)`);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`subcategory=${blocks.id}`));
    await expect(records).toHaveText('23 records');
    await page.goForward();
    await expect(records).toHaveText('1 record');

    await page.reload();
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    await searchProducts();
    await expect(subcategoryTrigger).toContainText(`${puzzles.name} (archived)`);
    await expect(records).toHaveText('1 record');

    await choose(page, 'Website subcategory', 'All subcategories');
    await expect(page).not.toHaveURL(/subcategory=/);
    await expect(records).toHaveText('25 records');
  });

  await test.step('legacy headphones show the website subcategory and the family tab clears the filter', async () => {
    await choose(page, 'Website subcategory', blocks.name);
    await familyTab('Headphones').click();
    await expect(page).not.toHaveURL(/subcategory=/);
    await searchProducts();
    const headphones = await taxonomy({
      kind: 'taxonomy',
      operation: 'read',
      family: 'headphones',
    });
    const office = headphones.children.find((child) => child.id === 'headphones-office');
    if (!office) throw new Error('Missing legacy office subcategory');
    await expect(subcategoriesOf(legacy)).toHaveText(
      office.status === 'archived' ? `${office.name} (archived)` : office.name,
    );
  });

  await test.step('edit form shows the saved classification read-only', async () => {
    await familyTab('Toys').click();
    await searchProducts();
    await rowFor(both).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Product', exact: true });
    const summary = editor.getByRole('region', { name: 'Saved website classification' });
    await expect(summary).toContainText('Toys');
    await expect(summary.locator('[data-saved-subcategories]')).toHaveText(
      `${blocks.name}, ${puzzles.name} (archived)`,
    );
    await expect(summary.locator('input, select, textarea')).toHaveCount(0);
    await editor.screenshot({ path: info.outputPath('edit-summary-1440.png') });
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toHaveCount(0);
  });

  await test.step('registry failures show a retry that recovers without reload', async () => {
    // Fault injection only for the registry read; every other admin call hits the real API.
    await page.route('**/api/admin', async (route) => {
      const body = route.request().postDataJSON() as { action?: string };
      if (body.action === 'catalogCategories') {
        await route.fulfill({ status: 503, body: 'unavailable' });
        return;
      }
      await route.continue();
    });
    await page.goto('/admin?productFamily=toys');
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Toys subcategories could not be loaded' });
    await expect(alert).toBeVisible();
    // Rows mounting on an errored query refetch once; wait until they have failed too.
    await expect(page.locator('[data-subcategory-state="error"]').first()).toBeVisible();
    await expect(page.locator('[data-subcategory-state="loading"]')).toHaveCount(0);
    await page.unroute('**/api/admin');
    await alert.getByRole('button', { name: 'Retry subcategories', exact: true }).click();
    await expect(subcategoryTrigger).toBeVisible();
    await searchProducts();
    await expect(subcategoriesOf(both)).toHaveText(`${blocks.name}, ${puzzles.name} (archived)`);
  });

  await test.step('mobile keeps the filter usable', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await choose(page, 'Website subcategory', blocks.name);
    await expect(records).toHaveText('23 records');
    await page.screenshot({ path: info.outputPath('toys-filter-390.png'), fullPage: true });
  });

  expect(await revisions()).toEqual(before);
  expect(errors).toEqual([]);
});

test('bulk classification publishes confirmed selections and reports rejected publications', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const session = await loginAdmin(request);
  const seeds = await adminAction<ListResult<CollectionDoc>>(
    request,
    'list',
    { collection: 'products', page: 1, pageSize: 100 },
    session.token,
  );
  const imageIds = seeds.items.find(
    (item) => Array.isArray(item.imageIds) && item.imageIds.length,
  )?.imageIds;
  expect(Array.isArray(imageIds) && imageIds.length > 0).toBe(true);
  const initial = CatalogTaxonomyResultSchema.parse(
    await adminAction<unknown>(
      request,
      'catalogCategories',
      { kind: 'taxonomy', operation: 'read', family: 'toys' },
      session.token,
    ),
  );
  if (!('registry' in initial)) throw new Error('Toy categories unavailable');
  const child = {
    id: `${e2e.runId}-bulk-toys`,
    slug: `${e2e.runId}-bulk-toys`,
    name: `Bulk toys ${e2e.runId}`,
    order: initial.registry.children.length,
    status: 'active' as const,
  };
  const saved = CatalogTaxonomyResultSchema.parse(
    await adminAction<unknown>(
      request,
      'catalogCategories',
      {
        kind: 'taxonomy',
        operation: 'save',
        family: 'toys',
        expectedRevision: initial.registry.revision,
        name: initial.registry.name,
        children: [...initial.registry.children, child],
      },
      session.token,
    ),
  );
  expect(saved.status).toMatch(/configured|applied/);
  const prefix = `${e2e.runId} Bulk workflow`;
  async function create(label: string, images: unknown) {
    return adminAction<CollectionDoc>(
      request,
      'create',
      {
        collection: 'products',
        values: {
          name: `${prefix} ${label}`,
          productFamily: 'toys',
          description: 'Disposable combined classification and publication.',
          imageIds: images,
          unitPrice: 5.7,
          published: false,
          archived: false,
        },
      },
      session.token,
    );
  }
  const excluded = await create('Excluded', imageIds);
  const rejected = await create('Rejected', []);
  const later = await create('Later', imageIds);
  const first = await create('First', imageIds);
  const second = await create('Second', imageIds);
  const raced = await create('Concurrent edit', imageIds);
  const read = (id: string) =>
    adminAction<CollectionDoc>(request, 'get', { collection: 'products', id }, session.token);
  const excludedBefore = await read(excluded._id);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes: { action: string; ids: string[] }[] = [];
  page.on('request', (webRequest) => {
    if (!webRequest.url().endsWith('/api/admin') || webRequest.method() !== 'POST') return;
    const body = webRequest.postDataJSON() as {
      action: string;
      data?: {
        kind?: string;
        products?: { productId: string }[];
        id?: string;
        values?: { published?: boolean };
      };
    };
    if (body.action === 'catalogCategories' && body.data?.kind === 'assignment')
      writes.push({
        action: 'classify',
        ids: body.data.products?.map((item) => item.productId) ?? [],
      });
    if (body.action === 'update' && body.data?.values?.published === true)
      writes.push({ action: 'publish', ids: [body.data.id ?? ''] });
  });
  await page.addInitScript(
    ({ session, origin }) => {
      if (window.location.origin !== origin) return;
      localStorage.setItem('channel.token', session.token);
      localStorage.setItem('channel.user', JSON.stringify(session.user));
    },
    { session, origin: new URL(e2e.siteUrl).origin },
  );
  await page.goto('/admin?productFamily=toys');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill(prefix);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const row = (product: CollectionDoc) =>
    page.getByRole('row').filter({ has: page.getByText(String(product.name), { exact: true }) });
  async function selectAndReview(products: CollectionDoc[]) {
    for (const product of products)
      await row(product).getByRole('checkbox', { name: 'Select row', exact: true }).check();
    await page.getByRole('button', { name: 'Assign category', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit website classification' });
    await expect(
      dialog.getByRole('checkbox', {
        name: 'Publish only after all classifications are confirmed',
      }),
    ).toBeChecked();
    await dialog.getByRole('checkbox', { name: child.name, exact: true }).check();
    await dialog.getByRole('button', { name: 'Review classification and publish' }).click();
    await expect(dialog).toContainText(
      'Publish all selected products after classification is confirmed.',
    );
    return dialog;
  }
  const success = await selectAndReview([first, second]);
  expect(await read(first._id)).toMatchObject({ published: false });
  await success.getByRole('button', { name: 'Confirm assignment' }).click();
  await expect(success).toContainText('2 products classified and published.');
  await expect(success.locator('section[role="status"]')).toContainText('2 published');
  const firstIds = writes[0]?.ids ?? [];
  expect([...firstIds].sort()).toEqual([first._id, second._id].sort());
  expect(writes).toEqual([
    { action: 'classify', ids: firstIds },
    ...firstIds.map((id) => ({ action: 'publish', ids: [id] })),
  ]);
  for (const product of [first, second])
    expect(await read(product._id)).toMatchObject({ published: true, subcategoryIds: [child.id] });
  expect(await read(excluded._id)).toEqual(excludedBefore);
  await success.getByRole('button', { name: 'Done' }).click();
  await expect(success).toHaveCount(0);
  const partial = await selectAndReview([later, rejected]);
  await partial.getByRole('button', { name: 'Confirm assignment' }).click();
  await expect(partial.locator('section[role="alert"]')).toContainText('1 published');
  await expect(partial.locator('section[role="alert"]')).toContainText('1 need attention');
  const laterIds = writes[3]?.ids ?? [];
  expect([...laterIds].sort()).toEqual([later._id, rejected._id].sort());
  expect(writes.slice(3)).toEqual([
    { action: 'classify', ids: laterIds },
    ...laterIds.map((id) => ({ action: 'publish', ids: [id] })),
  ]);
  expect(await read(later._id)).toMatchObject({ published: true, subcategoryIds: [child.id] });
  expect(await read(rejected._id)).toMatchObject({ published: false, subcategoryIds: [child.id] });
  expect(await read(excluded._id)).toEqual(excludedBefore);
  await partial.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  let intervened = false;
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: { id?: string; values?: { published?: boolean }; expectedUpdatedAt?: string };
    };
    if (
      body.action === 'update' &&
      body.data?.id === raced._id &&
      body.data.values?.published === true
    ) {
      expect(body.data.expectedUpdatedAt).toBe((await read(raced._id)).updatedAt);
      await adminAction(
        request,
        'update',
        {
          collection: 'products',
          id: raced._id,
          values: { description: 'Another admin changed this draft after classification.' },
        },
        session.token,
      );
      intervened = true;
    }
    await route.continue();
  });
  const conflict = await selectAndReview([raced]);
  await conflict.getByRole('button', { name: 'Confirm assignment' }).click();
  await expect(conflict.locator('section[role="alert"]')).toContainText('0 published');
  await expect(conflict.locator('section[role="alert"]')).toContainText(
    'changed since classification',
  );
  expect(intervened).toBe(true);
  expect(await read(raced._id)).toMatchObject({ published: false, subcategoryIds: [child.id] });
  await page.unrouteAll();
  const publicResponse = await request.get(
    `${e2e.apiUrl}/api/products?search=${encodeURIComponent(prefix)}`,
  );
  expect(publicResponse.ok()).toBe(true);
  const publicBody: { data: ListResult<CollectionDoc> } = await publicResponse.json();
  expect(publicBody.data.items.map((item) => item._id).sort()).toEqual(
    [first._id, second._id, later._id].sort(),
  );
  expect(errors).toEqual([]);
});
