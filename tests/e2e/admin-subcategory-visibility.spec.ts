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
import { type ListResult, adminAction, loginAdmin, loginUser } from './helpers/admin-api';
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
  // A pending-review badge appends "N product(s) to review" to the tab name.
  const familyTab = (label: string) =>
    page
      .getByRole('group', { name: 'Product family', exact: true })
      .getByRole('button', { name: new RegExp(`^${label}(?: \\d+ products? to review)?$`) });
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

test('confirmed publication keeps its receipt when the product status refresh fails', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const health = await request.get(`${e2e.apiUrl}/api/health`);
  const healthBody: { data?: { mode?: unknown; db?: unknown } } = await health.json();
  expect(healthBody.data?.mode).toBe('local');
  expect(healthBody.data?.db).toBe(e2e.catalogLocalDb);
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
  const product = await adminAction<CollectionDoc>(
    request,
    'create',
    {
      collection: 'products',
      values: {
        name: `${e2e.runId} Readback failure`,
        productFamily: 'toys',
        description: 'Disposable publication readback acceptance.',
        imageIds,
        unitPrice: 5.7,
        published: false,
        archived: false,
      },
    },
    session.token,
  );
  await page.addInitScript(
    ({ token, user }) => {
      localStorage.setItem('channel.token', token);
      localStorage.setItem('channel.user', JSON.stringify(user));
    },
    { token: session.token, user: session.user },
  );
  await page.goto('/admin?productFamily=toys');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill(String(product.name));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: String(product.name) })
    .getByRole('button', { name: 'Classify' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Edit website classification' });
  await dialog.getByRole('button', { name: 'Save and publish' }).click();
  let published = false;
  let publicationRequests = 0;
  let productReadBeforeList = false;
  let releaseReadback!: () => void;
  let readbackStarted!: () => void;
  const readbackGate = new Promise<void>((resolve) => {
    releaseReadback = resolve;
  });
  const readbackRequest = new Promise<void>((resolve) => {
    readbackStarted = resolve;
  });
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: { collection?: string; id?: string; values?: { published?: boolean } };
    };
    if (body.action === 'list' && body.data?.collection === 'products' && published) {
      readbackStarted();
      await readbackGate;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"ok":false,"error":{"code":"UNAVAILABLE","message":"Readback unavailable"}}',
      });
      return;
    }
    if (body.action === 'get' && body.data?.id === product._id && published)
      productReadBeforeList = true;
    if (
      body.action === 'update' &&
      body.data?.id === product._id &&
      body.data.values?.published === true
    ) {
      publicationRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 750));
      published = true;
    }
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Confirm save and publish' }).click();
  await expect(dialog.getByText('Publishing selected products...', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Publishing product \d+ of/)).toHaveCount(0);
  await readbackRequest;
  try {
    await expect(dialog.getByText('Checking product statuses...', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Done' })).toHaveCount(0);
    expect(productReadBeforeList).toBe(false);
  } finally {
    releaseReadback();
  }
  await expect(dialog).toContainText('1 published');
  await expect(dialog).toContainText('Product statuses could not be verified');
  await expect(dialog.getByRole('button', { name: 'Check later' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Done' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Dismiss' }).click();
  await dialog.getByRole('button', { name: 'View publication receipts' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: '1 published' })).toBeVisible();
  expect(publicationRequests).toBe(1);
  expect(
    await adminAction<CollectionDoc>(
      request,
      'get',
      { collection: 'products', id: product._id },
      session.token,
    ),
  ).toMatchObject({ published: true });
  await page.unrouteAll();
  let statusReads = 0;
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: { collection?: string; id?: string };
    };
    if (
      body.action === 'get' &&
      body.data?.collection === 'products' &&
      body.data.id === product._id
    ) {
      statusReads += 1;
      await route.fulfill({ status: 503, json: { ok: false, error: { code: 'UNAVAILABLE' } } });
      return;
    }
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Refresh statuses' }).click();
  await expect.poll(() => statusReads).toBe(1);
  await expect(dialog).toContainText('Product statuses could not be verified');
  await expect(dialog.getByRole('button', { name: 'Done' })).toHaveCount(0);
  await page.unrouteAll();
  await dialog.getByRole('button', { name: 'Refresh statuses' }).click();
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('alert').filter({ hasText: String(product.name) })).toHaveCount(0);
  expect(publicationRequests).toBe(1);
});

test('Check later retains confirmed publication receipts and restores row focus', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
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
  const product = await adminAction<CollectionDoc>(
    request,
    'create',
    {
      collection: 'products',
      values: {
        name: `${e2e.runId} Retained publication`,
        productFamily: 'toys',
        description: 'Disposable confirmed receipt test.',
        imageIds,
        unitPrice: 5.7,
        published: false,
        archived: false,
      },
    },
    session.token,
  );
  await page.addInitScript(
    ({ token, user }) => {
      localStorage.setItem('channel.token', token);
      localStorage.setItem('channel.user', JSON.stringify(user));
    },
    { token: session.token, user: session.user },
  );
  await page.goto('/admin?productFamily=toys');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill(String(product.name));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: String(product.name) });
  const opener = row.getByRole('button', { name: 'Classify' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Edit website classification' });
  await dialog.getByRole('button', { name: 'Save and publish' }).click();
  let published = false;
  let publications = 0;
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: { collection?: string; id?: string; values?: { published?: boolean } };
    };
    if (body.action === 'list' && body.data?.collection === 'products' && published) {
      await route.fulfill({ status: 503, json: { ok: false, error: { code: 'UNAVAILABLE' } } });
      return;
    }
    if (
      body.action === 'update' &&
      body.data?.id === product._id &&
      body.data.values?.published === true
    ) {
      publications += 1;
      published = true;
    }
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Confirm save and publish' }).click();
  await expect(dialog).toContainText('Product statuses could not be verified');
  await page.unrouteAll();
  await dialog.getByRole('button', { name: 'Check later' }).click();
  await expect(dialog).toHaveCount(0);
  const reminder = page.getByRole('alert').filter({ hasText: String(product.name) });
  await expect(reminder).toContainText('1 confirmed published; 0 unresolved');
  await expect(
    reminder.getByRole('button', { name: 'Clear selection and reminder' }),
  ).toBeFocused();
  const savedProduct = await adminAction<CollectionDoc>(
    request,
    'get',
    { collection: 'products', id: product._id },
    session.token,
  );
  let productReadBeforeList = false;
  let listCompleted = false;
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: { id?: string; collection?: string };
    };
    if (body.action === 'list' && body.data?.collection === 'products') {
      const response = await route.fetch();
      await route.fulfill({ response });
      listCompleted = true;
      return;
    }
    if (body.action === 'get' && body.data?.id === product._id) {
      productReadBeforeList = !listCompleted;
      await route.fulfill({
        status: 200,
        json: { ok: true, data: { ...savedProduct, subcategoryIds: ['wrong-child'] } },
      });
      return;
    }
    await route.continue();
  });
  await reminder.getByRole('button', { name: 'Refresh statuses' }).click();
  await expect(reminder).toContainText('Inspect affected products');
  expect(productReadBeforeList).toBe(false);
  await expect(row.getByRole('checkbox', { name: 'Select row' })).toBeChecked();
  await page.unrouteAll();
  let releaseSectionRefresh!: () => void;
  let sectionRefreshStarted!: () => void;
  const sectionRefreshGate = new Promise<void>((resolve) => {
    releaseSectionRefresh = resolve;
  });
  const sectionRefreshRequest = new Promise<void>((resolve) => {
    sectionRefreshStarted = resolve;
  });
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as { action?: string; data?: { id?: string } };
    if (body.action === 'get' && body.data?.id === product._id) {
      sectionRefreshStarted();
      await sectionRefreshGate;
    }
    await route.continue();
  });
  await reminder.getByRole('button', { name: 'Refresh statuses' }).click();
  await sectionRefreshRequest;
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  releaseSectionRefresh();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await expect(reminder).toBeVisible();
  await page.unrouteAll();
  await page.getByPlaceholder(/^Search name/).fill(String(product.name));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(row.getByRole('checkbox', { name: 'Select row' })).toBeChecked();
  let releaseOldRefresh!: () => void;
  let oldRefreshStarted!: () => void;
  const oldRefreshGate = new Promise<void>((resolve) => {
    releaseOldRefresh = resolve;
  });
  const oldRefreshRequest = new Promise<void>((resolve) => {
    oldRefreshStarted = resolve;
  });
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as { action?: string; data?: { id?: string } };
    if (body.action === 'get' && body.data?.id === product._id) {
      oldRefreshStarted();
      await oldRefreshGate;
    }
    await route.continue();
  });
  await reminder.getByRole('button', { name: 'Refresh statuses' }).click();
  await oldRefreshRequest;
  await row.getByRole('checkbox', { name: 'Select row' }).uncheck();
  await row.getByRole('checkbox', { name: 'Select row' }).check();
  releaseOldRefresh();
  await page.waitForLoadState('networkidle');
  await expect(reminder).toHaveCount(0);
  await expect(row.getByRole('checkbox', { name: 'Select row' })).toBeChecked();
  expect(publications).toBe(1);
});

test('lost assignment response preserves the selected product after Escape', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const session = await loginAdmin(request);
  const product = await adminAction<CollectionDoc>(
    request,
    'create',
    {
      collection: 'products',
      values: {
        name: `${e2e.runId} Unconfirmed assignment`,
        productFamily: 'toys',
        description: 'Disposable assignment response test.',
        published: false,
        archived: false,
      },
    },
    session.token,
  );
  await page.addInitScript(
    ({ token, user }) => {
      localStorage.setItem('channel.token', token);
      localStorage.setItem('channel.user', JSON.stringify(user));
    },
    { token: session.token, user: session.user },
  );
  await page.goto('/admin?productFamily=toys');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill(String(product.name));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: String(product.name) });
  await row.getByRole('checkbox', { name: 'Select row' }).check();
  const before = await adminAction<CollectionDoc>(
    request,
    'get',
    { collection: 'products', id: product._id },
    session.token,
  );
  await row.getByRole('button', { name: 'Classify' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit website classification' });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Classify' })).toBeFocused();
  const after = await adminAction<CollectionDoc>(
    request,
    'get',
    { collection: 'products', id: product._id },
    session.token,
  );
  expect(after.updatedAt).toBe(before.updatedAt);
  await row.getByRole('button', { name: 'Classify' }).click();
  await dialog.getByRole('button', { name: 'Save classification' }).click();
  let assignments = 0;
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: { kind?: string; operation?: string };
    };
    if (body.action === 'catalogCategories' && body.data?.kind === 'assignment') {
      assignments += 1;
      await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 750));
      await route.fulfill({ status: 503, json: { ok: false, error: { code: 'UNAVAILABLE' } } });
      return;
    }
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Confirm save' }).click();
  await expect(dialog).toContainText('Saving classification...');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Assignment was not confirmed');
  await expect(dialog.getByRole('button', { name: 'Check later' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: String(product.name) })).toContainText(
    'not confirmed',
  );
  await expect(row.getByRole('checkbox', { name: 'Select row' })).toBeChecked();
  await expect(row.getByRole('button', { name: 'Classify' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Assign category' })).toBeDisabled();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(row.getByRole('checkbox', { name: 'Select row' })).not.toBeChecked();
  await expect(page.getByRole('alert').filter({ hasText: String(product.name) })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Classify' })).toBeDisabled();
  await row.getByRole('checkbox', { name: 'Select row' }).check();
  await page.getByPlaceholder(/^Search name/).fill('no matching products');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: String(product.name) })).toBeVisible();
  await page.getByPlaceholder(/^Search name/).fill(String(product.name));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(row.getByRole('checkbox', { name: 'Select row' })).toBeChecked();
  const reminder = page.getByRole('alert').filter({ hasText: String(product.name) });
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await expect(reminder).toBeVisible();
  await page.getByPlaceholder(/^Search name/).fill(String(product.name));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(row.getByRole('checkbox', { name: 'Select row' })).toBeChecked();
  await reminder.getByRole('button', { name: 'Refresh statuses' }).click();
  await expect(reminder).toHaveCount(0);
  await expect(row.getByRole('checkbox', { name: 'Select row' })).not.toBeChecked();
  await expect(row.getByRole('button', { name: 'Classify' })).toBeEnabled();
  await row.getByRole('checkbox', { name: 'Select row' }).check();
  await expect(page.getByRole('button', { name: 'Assign category' })).toBeEnabled();
  expect(assignments).toBe(1);
});

test('tablet product actions keep classification visible and visibility commands in Actions', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 768, height: 900 });
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
  const product = await adminAction<CollectionDoc>(
    request,
    'create',
    {
      collection: 'products',
      values: {
        name: `${e2e.runId} Tablet actions`,
        productFamily: 'toys',
        description: 'Local-only tablet controls.',
        imageIds,
        published: false,
        archived: false,
      },
    },
    session.token,
  );
  await page.addInitScript(
    ({ token, user }) => {
      localStorage.setItem('channel.token', token);
      localStorage.setItem('channel.user', JSON.stringify(user));
    },
    { token: session.token, user: session.user },
  );
  await page.goto('/admin?productFamily=toys');
  await page.getByRole('combobox', { name: 'Section' }).and(page.locator('button')).click();
  await page
    .getByRole('listbox', { name: 'Section' })
    .getByRole('option', { name: 'Products', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Product family' })).toBeVisible();
  const family = page.getByRole('combobox', { name: 'Product family' }).and(page.locator('button'));
  await family.click();
  await page.getByRole('option', { name: /^Headphones/ }).click();
  await expect(page).toHaveURL(/productFamily=headphones/);
  await family.click();
  await page.getByRole('option', { name: /^Toys/ }).click();
  await expect(page).toHaveURL(/productFamily=toys/);
  await page.getByPlaceholder(/^Search name/).fill(String(product.name));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: String(product.name) })
    .getByRole('checkbox', { name: 'Select row' })
    .check();
  await expect(page.getByRole('button', { name: 'Assign category' })).toBeVisible();
  const actions = page.locator('details').filter({
    has: page.locator('summary').filter({ hasText: 'Actions' }),
  });
  await actions.locator('summary').click();
  await expect(actions.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('combobox', { name: 'Product family' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assign category' })).toBeVisible();
    await expect(actions.locator('summary')).toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('combobox', { name: 'Product family' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Toys', exact: true })).toBeVisible();
  await expect(actions.locator('summary')).toBeHidden();
  await page.setViewportSize({ width: 768, height: 900 });
  const writes: string[] = [];
  page.on('request', (webRequest) => {
    if (!webRequest.url().endsWith('/api/admin') || webRequest.method() !== 'POST') return;
    const body = webRequest.postDataJSON() as {
      action: string;
      data?: { kind?: string; values?: { published?: boolean } };
    };
    if (body.action === 'catalogCategories' && body.data?.kind === 'assignment')
      writes.push('classify');
    if (body.action === 'update' && body.data?.values?.published === true) writes.push('publish');
  });
  await actions.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: String(product.name) })
      .getByRole('button', { name: 'Published' }),
  ).toBeVisible();
  expect(writes).toEqual(['publish']);
  const row = page.getByRole('row').filter({ hasText: String(product.name) });
  await row.getByRole('checkbox', { name: 'Select row' }).check();
  let releaseUpdate!: () => void;
  let updateStarted!: () => void;
  const updateGate = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const pendingUpdate = new Promise<void>((resolve) => {
    updateStarted = resolve;
  });
  await page.route('**/api/admin', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: { id?: string; values?: { published?: boolean } };
    };
    if (
      body.action === 'update' &&
      body.data?.id === product._id &&
      body.data.values?.published === false
    ) {
      updateStarted();
      await updateGate;
    }
    await route.continue();
  });
  await row.getByRole('button', { name: 'Published' }).click();
  await pendingUpdate;
  try {
    await expect(row.getByRole('button', { name: 'Classify' })).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Edit' })).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Archive' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Assign category' })).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Preview' })).toBeEnabled();
  } finally {
    releaseUpdate();
  }
  await expect(row.getByRole('button', { name: 'Disabled' })).toBeVisible();
});

test('contributor sees products but not the admin-only bulk classification action', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const admin = await loginAdmin(request);
  const product = await adminAction<CollectionDoc>(
    request,
    'create',
    {
      collection: 'products',
      values: {
        name: `${e2e.runId} Contributor visibility`,
        productFamily: 'toys',
        description: 'Local-only permissions check.',
        published: false,
        archived: false,
      },
    },
    admin.token,
  );
  const { token, user } = await loginUser(request, 'contributor@channel.local', 'password');
  expect(user.role).toBe('contributor');
  await page.addInitScript(
    ({ token, user }) => {
      localStorage.setItem('channel.token', token);
      localStorage.setItem('channel.user', JSON.stringify(user));
    },
    { token, user },
  );
  await page.goto('/admin?productFamily=toys');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill(String(product.name));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: String(product.name) })
    .getByRole('checkbox', { name: 'Select row' })
    .check();
  await expect(page.getByRole('button', { name: 'Assign category' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear selection' })).toBeVisible();
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
    await expect(dialog.getByRole('button', { name: 'Save classification' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save and publish' })).toBeVisible();
    await dialog.getByRole('checkbox', { name: child.name, exact: true }).check();
    await dialog.getByRole('button', { name: 'Save and publish' }).click();
    await expect(dialog).toContainText(
      'Publish all selected products after classification is confirmed.',
    );
    return dialog;
  }
  for (const product of [first, second, excluded])
    await row(product).getByRole('checkbox', { name: 'Select row', exact: true }).check();
  await page.getByRole('button', { name: 'Assign category', exact: true }).click();
  const previewDialog = page.getByRole('dialog', { name: 'Edit website classification' });
  const preview = previewDialog.locator('[aria-label="Selected product preview"]');
  await expect(preview.getByText(String(first.name), { exact: true })).toBeVisible();
  await expect(preview.getByText(String(second.name), { exact: true })).toBeVisible();
  await expect(preview.getByText(String(excluded.name), { exact: true })).toBeHidden();
  await preview.getByText('Show all 3 products').click();
  await expect(preview.getByText(String(excluded.name), { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(previewDialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  const success = await selectAndReview([first, second]);
  expect(await read(first._id)).toMatchObject({ published: false });
  await success.getByRole('button', { name: 'Confirm save and publish' }).click();
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
  await partial.getByRole('button', { name: 'Confirm save and publish' }).click();
  await expect(partial.locator('section[role="alert"]')).toContainText('1 published');
  await expect(partial.locator('section[role="alert"]')).toContainText('1 need attention');
  const laterIds = writes[3]?.ids ?? [];
  expect([...laterIds].sort()).toEqual([later._id, rejected._id].sort());
  // With detail approval on (the formal lane), a manual product is approved
  // before it publishes (MIU-32) and one without an image is refused in the
  // browser before any publish write; with it off, both are attempted.
  const approvalOn = process.env.E2E_CATALOG_FORMAL === '1';
  expect(writes.slice(3)).toEqual([
    { action: 'classify', ids: laterIds },
    ...(approvalOn
      ? [{ action: 'publish', ids: [later._id] }]
      : laterIds.map((id) => ({ action: 'publish', ids: [id] }))),
  ]);
  expect(await read(later._id)).toMatchObject({ published: true, subcategoryIds: [child.id] });
  expect(await read(rejected._id)).toMatchObject({ published: false, subcategoryIds: [child.id] });
  expect(await read(excluded._id)).toEqual(excludedBefore);
  await partial.getByRole('button', { name: 'Check later', exact: true }).click();
  const partialReminder = page.getByRole('alert').filter({ hasText: String(rejected.name) });
  await expect(partialReminder).toContainText('1 need attention');
  await expect(partialReminder.locator('p').nth(1)).toHaveText(String(rejected.name));
  const attention = page.getByRole('list', { name: 'Products needing attention' });
  await expect(attention).toContainText(String(rejected.name));
  await expect(attention).toContainText(/image/i);
  await expect(attention).not.toContainText(String(later.name));
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(partialReminder).toBeVisible();
  await partialReminder.getByRole('button', { name: 'Clear selection and reminder' }).click();
  await expect(partialReminder).toHaveCount(0);
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
  await conflict.getByRole('button', { name: 'Confirm save and publish' }).click();
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
  await conflict.getByRole('button', { name: 'Check later' }).click();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();

  const lostResponse = await create('Lost publication response', imageIds);
  await page.reload();
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill(prefix);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  let committedWithoutResponse = 0;
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: { id?: string; values?: { published?: boolean } };
    };
    if (
      body.action === 'update' &&
      body.data?.id === lostResponse._id &&
      body.data.values?.published === true
    ) {
      await route.fetch();
      committedWithoutResponse += 1;
      await route.fulfill({ status: 503, json: { ok: false, error: { code: 'UNAVAILABLE' } } });
      return;
    }
    await route.continue();
  });
  const writesBeforeLoss = writes.length;
  const unknown = await selectAndReview([lostResponse]);
  await unknown.getByRole('button', { name: 'Confirm save and publish' }).click();
  await expect(unknown.getByRole('button', { name: 'Check later' })).toBeEnabled();
  expect(await read(lostResponse._id)).toMatchObject({
    published: true,
    subcategoryIds: [child.id],
  });
  expect(committedWithoutResponse).toBe(1);
  expect(writes.slice(writesBeforeLoss)).toEqual([
    { action: 'classify', ids: [lostResponse._id] },
    { action: 'publish', ids: [lostResponse._id] },
  ]);
  await page.unrouteAll();
  await unknown.getByRole('button', { name: 'Check later' }).click();
  const reminder = page.getByRole('alert').filter({ hasText: String(lostResponse.name) });
  await expect(reminder).toContainText('1 unresolved');
  await expect(reminder.getByRole('list', { name: 'Products to verify' })).toContainText(
    String(lostResponse.name),
  );
  await reminder.getByRole('button', { name: 'Refresh statuses' }).click();
  await expect(reminder).toHaveCount(0);
  await expect(
    row(lostResponse).getByRole('checkbox', { name: 'Select row', exact: true }),
  ).not.toBeChecked();
  expect(writes.slice(writesBeforeLoss)).toHaveLength(2);

  const inDialogReadback = await create('Dialog publication readback', imageIds);
  await page.reload();
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill(prefix);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: { id?: string; values?: { published?: boolean } };
    };
    if (
      body.action === 'update' &&
      body.data?.id === inDialogReadback._id &&
      body.data.values?.published === true
    ) {
      await route.fetch();
      await route.fulfill({ status: 503, json: { ok: false, error: { code: 'UNAVAILABLE' } } });
      return;
    }
    await route.continue();
  });
  const writesBeforeDialogReadback = writes.length;
  const readback = await selectAndReview([inDialogReadback]);
  await readback.getByRole('button', { name: 'Confirm save and publish' }).click();
  await expect(readback.getByRole('button', { name: 'Check later' })).toBeEnabled();
  await page.unrouteAll();
  await readback.getByRole('button', { name: 'Refresh statuses' }).click();
  await expect(readback).toContainText('Current product statuses verified');
  await expect(readback.getByRole('button', { name: 'Done' })).toBeEnabled();
  expect(await read(inDialogReadback._id)).toMatchObject({
    published: true,
    subcategoryIds: [child.id],
  });
  await readback.getByRole('button', { name: 'Done' }).click();
  expect(writes.slice(writesBeforeDialogReadback)).toEqual([
    { action: 'classify', ids: [inDialogReadback._id] },
    { action: 'publish', ids: [inDialogReadback._id] },
  ]);
  expect(errors).toEqual([]);
});

test('product row and bulk Archive use supported updates instead of forbidden deletion', async ({
  page,
  request,
}) => {
  const session = await loginAdmin(request);
  const prefix = `${marker} archive`;
  const products: CollectionDoc[] = [];
  for (const suffix of ['row', 'bulk']) {
    products.push(
      await adminAction<CollectionDoc>(
        request,
        'create',
        {
          collection: 'products',
          values: { name: `${prefix} ${suffix}`, productFamily: 'headphones', published: false },
        },
        session.token,
      ),
    );
  }
  const [rowProduct, bulkProduct] = products;
  if (!rowProduct || !bulkProduct) throw new Error('Archive fixtures were not created.');
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('channel.token', token);
    localStorage.setItem('channel.user', JSON.stringify(user));
  }, session);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin?productFamily=headphones');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill(prefix);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: `${prefix} row` });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  const actions: string[] = [];
  page.on('request', (event) => {
    if (!event.url().endsWith('/api/admin') || event.method() !== 'POST') return;
    const body = event.postDataJSON() as { action: string };
    actions.push(body.action);
  });
  page.on('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Archive', exact: true })).toBeDisabled();
  await expect
    .poll(async () =>
      adminAction<CollectionDoc>(
        request,
        'get',
        { collection: 'products', id: rowProduct._id },
        session.token,
      ),
    )
    .toMatchObject({ archived: true, published: false, productFamily: 'headphones' });
  const bulk = page.getByRole('row').filter({ hasText: `${prefix} bulk` });
  await bulk.getByRole('checkbox', { name: 'Select row', exact: true }).check();
  await page
    .getByText('1 selected', { exact: true })
    .locator('..')
    .getByRole('button', { name: 'Archive', exact: true })
    .filter({ visible: true })
    .click();
  await expect
    .poll(async () =>
      adminAction<CollectionDoc>(
        request,
        'get',
        { collection: 'products', id: bulkProduct._id },
        session.token,
      ),
    )
    .toMatchObject({ archived: true, published: false, productFamily: 'headphones' });
  expect(actions).not.toContain('remove');
  expect(actions).not.toContain('batchRemove');
  expect(actions.filter((action) => action === 'update')).toHaveLength(2);
});
