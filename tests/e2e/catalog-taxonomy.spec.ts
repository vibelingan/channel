import { type Locator, type Page, expect, test } from '@playwright/test';
import type { CatalogPage, Product } from '../../apps/site/src/islands/shop/catalog-types.ts';
import {
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
} from '../../packages/shared/src/catalog-product.ts';
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
import { expectProductSaved } from './helpers/product-save';

const enabled = e2e.catalogLocalSeed;
// @skip-when outside the disposable local runner; CI runs this lane with owned DB and synthetic credentials, whose absence then throws below.
test.skip(!enabled, 'Run through the disposable catalog-admin-local runner, never a live site.');
requireCatalogLocalSeedWhenEnabled(enabled);
requireAdminCredentialsWhenEnabled(enabled, 'local taxonomy journey');
if (
  enabled &&
  (!e2e.allowMutation || e2e.adminEmail !== 'admin@channel.local' || e2e.adminPassword !== 'admin')
) {
  throw new Error('Taxonomy requires the runner mutation opt-in and synthetic local credentials.');
}
test.describe.configure({ mode: 'serial', retries: 0 });

type ProductFixture = Pick<
  Product,
  'name' | 'productFamily' | 'description' | 'slug' | 'imageIds' | 'unitPrice'
> & { published: boolean; archived: boolean };
type PublicTaxonomy = Omit<CatalogTaxonomy, 'children'> & {
  children: Omit<CatalogTaxonomy['children'][number], 'status'>[];
};

function productFixture(
  family: ProductFamily,
  index: number,
  imageIds: string[],
  overrides: Partial<ProductFixture> = {},
): ProductFixture {
  return {
    name: `${e2e.runId} Taxonomy ${family} ${index}`,
    slug: `${e2e.runId}-taxonomy-${family}-${index}`,
    productFamily: family,
    description: 'Disposable local taxonomy acceptance product.',
    imageIds: [...imageIds],
    unitPrice: 5.7,
    published: false,
    archived: false,
    ...overrides,
  };
}

function childFixture(
  family: ProductFamily,
  index: number,
  overrides: Partial<CatalogTaxonomy['children'][number]> = {},
): CatalogTaxonomy['children'][number] {
  return {
    id: `${e2e.runId}-${family}-${index}`,
    name: `Local ${family} child ${index}`,
    slug: `${e2e.runId}-${family}-${index}`,
    order: index,
    status: 'active',
    ...overrides,
  };
}

async function choose(scope: Locator, label: string, option: string) {
  await scope
    .getByRole('combobox', { name: label, exact: true })
    .and(scope.locator('button'))
    .click();
  await scope
    .getByRole('listbox', { name: label, exact: true })
    .getByRole('option', { name: option, exact: true })
    .click();
}

async function openProducts(page: Page, search?: string) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  if (search !== undefined) {
    await page.getByPlaceholder(/^Search name/).fill(search);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
  }
}

test('local taxonomy: saved categories and assignments drive all four storefronts', async ({
  page,
  request,
}, info) => {
  test.setTimeout(300_000);
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
    if (command.operation === 'read') expect(result.status).toBe('replayed');
    else expect(['configured', 'applied']).toContain(result.status);
    return result.registry;
  }
  const readTaxonomy = (family: ProductFamily) =>
    taxonomy({ kind: 'taxonomy', operation: 'read', family });
  const saveTaxonomy = (registry: CatalogTaxonomy) =>
    taxonomy({
      kind: 'taxonomy',
      operation: 'save',
      family: registry.family,
      expectedRevision: registry.revision,
      name: registry.name,
      children: registry.children,
    });
  async function assign(registry: CatalogTaxonomy, ids: string[], subcategoryIds: string[]) {
    const products = await Promise.all(ids.map(readProduct));
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
    expect(result.results).toEqual(ids.map((productId) => ({ productId, status: 'saved' })));
  }
  async function publicProducts(family: ProductFamily, categories?: string[], number = 1) {
    const params = new URLSearchParams({
      productFamily: family,
      search: `${e2e.runId} Taxonomy`,
      page: String(number),
      pageSize: '12',
    });
    if (categories) params.set('subcategoryIds', categories.join(','));
    const response = await request.get(`${e2e.apiUrl}/api/products?${params}`);
    expect(response.ok()).toBe(true);
    const body: { ok: boolean; data: CatalogPage } = await response.json();
    expect(body.ok).toBe(true);
    return body.data;
  }
  async function publicTaxonomy(family: ProductFamily) {
    const response = await request.get(`${e2e.apiUrl}/api/catalog-taxonomy?family=${family}`);
    expect(response.ok()).toBe(true);
    const body: { ok: boolean; data: PublicTaxonomy } = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.family).toBe(family);
    return {
      ...body.data,
      children: [...body.data.children].sort(
        (left, right) => left.order - right.order || left.id.localeCompare(right.id),
      ),
    };
  }
  async function openManager(family: ProductFamily, name: string) {
    await openProducts(page);
    await page.getByText('Manage website categories', { exact: true }).click();
    const manager = page.getByRole('region', { name: 'Catalog categories', exact: true });
    await choose(manager, 'Website main category', name);
    await expect(manager.getByLabel('Public main category name')).toHaveValue(name);
    expect((await readTaxonomy(family)).name).toBe(name);
    return manager;
  }
  async function saveManager(manager: Locator) {
    await manager.getByRole('button', { name: 'Save categories', exact: true }).click();
    await manager.getByRole('button', { name: 'Confirm category save', exact: true }).click();
    await expect(manager.getByRole('status')).toHaveText('Categories saved.');
  }
  async function confirmAssignment() {
    const dialog = page.getByRole('dialog', { name: 'Edit website classification', exact: true });
    await dialog.getByRole('button', { name: 'Review assignment', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }

  const seeds = await adminAction<ListResult<CollectionDoc>>(
    request,
    'list',
    { collection: 'products', pageSize: 100 },
    session.token,
  );
  const imageCandidates = seeds.items.flatMap((product) =>
    Array.isArray(product.imageIds)
      ? product.imageIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const imageIds: string[] = [];
  for (const id of new Set(imageCandidates)) {
    const response = await request.get(`${e2e.apiUrl}/api/images/${encodeURIComponent(id)}`);
    if (response.ok() && response.headers()['content-type']?.startsWith('image/')) {
      imageIds.push(id);
      break;
    }
  }
  expect(imageIds).toHaveLength(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login?returnTo=%2Fadmin');
  await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);

  for (const family of PRODUCT_FAMILY_OPTIONS) {
    await test.step(`${family}: real admin categories, draft assignments and publication`, async () => {
      let registry = await readTaxonomy(family);
      const previousCount = registry.children.length;
      if (family === 'toys' || family === 'misc') {
        const manager = await openManager(family, registry.name);
        for (const index of [1, 2]) {
          const child = childFixture(family, index);
          await manager.getByRole('button', { name: 'Add subcategory', exact: true }).click();
          await manager
            .getByRole('textbox', {
              name: `Subcategory ${previousCount + index} name`,
              exact: true,
            })
            .fill(child.name);
          await manager
            .getByRole('textbox', {
              name: `Subcategory ${previousCount + index} slug`,
              exact: true,
            })
            .fill(child.slug);
        }
        expect((await readTaxonomy(family)).children).toEqual(registry.children);
        await saveManager(manager);
        registry = await readTaxonomy(family);
      } else {
        registry = await saveTaxonomy({
          ...registry,
          children: [...registry.children, childFixture(family, 1), childFixture(family, 2)],
        });
      }
      const children = registry.children.slice(previousCount);
      expect(children).toHaveLength(2);
      const [firstChild, secondChild] = children;
      if (!firstChild || !secondChild) throw new Error('Missing local taxonomy children');
      const childIds = children.map((child) => child.id);
      await page.reload();
      expect((await readTaxonomy(family)).children.slice(previousCount)).toEqual(children);
      const products: CollectionDoc[] = [];
      for (let index = 1; index <= 14; index++) {
        products.push(
          await adminAction<CollectionDoc>(
            request,
            'create',
            {
              collection: 'products',
              values: productFixture(family, index, imageIds),
            },
            session.token,
          ),
        );
      }
      const [single, batchFirst, batchSecond, ...remaining] = products;
      if (!single || !batchFirst || !batchSecond) throw new Error('Missing local draft fixtures');
      await openProducts(page, String(single.name));
      const row = page
        .getByRole('row')
        .filter({ has: page.getByText(String(single.name), { exact: true }) });
      await row.getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Edit Product', exact: true });
      await editor
        .getByRole('textbox', { name: /^Description/ })
        .fill('Saved before classification and publication.');
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expectProductSaved(page);
      expect(await readProduct(single._id)).toMatchObject({
        description: 'Saved before classification and publication.',
        published: false,
      });
      await row.getByRole('button', { name: 'Classify', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: 'Edit website classification', exact: true });
      for (const child of children)
        await dialog.getByRole('checkbox', { name: child.name, exact: true }).check();
      expect((await readProduct(single._id)).subcategoryIds).toBeUndefined();
      await confirmAssignment();
      expect(await readProduct(single._id)).toMatchObject({
        subcategoryIds: childIds,
        published: false,
      });
      await page.reload();
      await openProducts(page, String(single.name));
      await row.getByRole('button', { name: 'Classify', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Edit website classification', exact: true });
      for (const child of children)
        await expect(dialog.getByRole('checkbox', { name: child.name, exact: true })).toBeChecked();
      await choose(dialog, 'Assignment mode', 'Clear subcategories');
      expect((await readProduct(single._id)).subcategoryIds).toEqual(childIds);
      await confirmAssignment();
      expect(await readProduct(single._id)).toMatchObject({ subcategoryIds: [], published: false });
      await openProducts(page, `${e2e.runId} Taxonomy ${family}`);
      for (const product of [batchFirst, batchSecond]) {
        await page
          .getByRole('row')
          .filter({ has: page.getByText(String(product.name), { exact: true }) })
          .getByRole('checkbox', { name: 'Select row', exact: true })
          .check();
      }
      await page.getByRole('button', { name: 'Assign category', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Edit website classification', exact: true });
      await expect(dialog).toContainText('2 selected products.');
      for (const child of children)
        await dialog.getByRole('checkbox', { name: child.name, exact: true }).check();
      await confirmAssignment();
      for (const product of [batchFirst, batchSecond])
        expect(await readProduct(product._id)).toMatchObject({
          subcategoryIds: childIds,
          published: false,
        });
      await assign(
        registry,
        remaining.map((product) => product._id),
        childIds,
      );
      expect((await publicProducts(family)).total).toBe(0);
      await openProducts(page, `${e2e.runId} Taxonomy ${family}`);
      await expect(page.getByRole('checkbox', { name: 'Select row', exact: true })).toHaveCount(14);
      await page.getByRole('checkbox', { name: 'Select all rows', exact: true }).check();
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect
        .poll(async () =>
          (await Promise.all(products.map((product) => readProduct(product._id)))).every(
            (product) => product.published === true,
          ),
        )
        .toBe(true);
      expect(await readProduct(single._id)).toMatchObject({ subcategoryIds: [], published: true });
      expect((await publicProducts(family)).total).toBe(14);

      await test.step('public filters, header, overlap deduplication and responsive evidence', async () => {
        const exposed = await publicTaxonomy(family);
        expect(exposed.children).toEqual(
          registry.children
            .filter((child) => child.status === 'active')
            .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
            .map(({ status: _status, ...child }) => child),
        );
        for (const child of children)
          expect((await publicProducts(family, [child.id])).total).toBe(13);
        const first = await publicProducts(family, childIds);
        const second = await publicProducts(family, childIds, 2);
        expect(first).toMatchObject({ total: 13, page: 1, pageSize: 12 });
        expect(second).toMatchObject({ total: 13, page: 2, pageSize: 12 });
        expect(first.items).toHaveLength(12);
        expect(second.items).toHaveLength(1);
        const secondPageProduct = second.items[0];
        if (!secondPageProduct) throw new Error('Missing second-page product');
        const expectedIds = products
          .filter((product) => product._id !== single._id)
          .map((product) => product._id)
          .sort();
        expect([...first.items, ...second.items].map((product) => product._id).sort()).toEqual(
          expectedIds,
        );
        const params = new URLSearchParams({
          category: childIds.join(','),
          search: `${e2e.runId} Taxonomy`,
          page: '1',
        });
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`/${family}/?${params}`);
          expect(await page.evaluate(() => window.innerWidth)).toBe(width);
          const cards = page.locator('[data-product-card]');
          await expect(cards).toHaveCount(12);
          expect(
            await cards.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute('data-product-card')),
            ),
          ).toEqual(first.items.map((product) => product._id));
          for (const child of children)
            await expect(
              page.getByRole('checkbox', { name: child.name, exact: true }),
            ).toBeChecked();
          await cards.first().scrollIntoViewIfNeeded();
          await expect
            .poll(() =>
              cards
                .first()
                .locator('img')
                .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
            )
            .toBe(true);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          await page.screenshot({
            path: info.outputPath(`${family}-${width}-page-1.png`),
            fullPage: true,
          });
          await page.getByRole('button', { name: 'Page 2', exact: true }).click();
          await expect(cards).toHaveCount(1);
          await expect(cards).toHaveAttribute('data-product-card', secondPageProduct._id);
          await page.reload();
          await expect(cards).toHaveCount(1);
          await expect(cards).toHaveAttribute('data-product-card', secondPageProduct._id);
          expect(new URL(page.url()).searchParams.get('page')).toBe('2');
          for (const child of children)
            await page.getByRole('checkbox', { name: child.name, exact: true }).uncheck();
          await expect(cards).toHaveCount(0);
          await expect(page.locator('[data-result-progress]')).toContainText('of 0 products');
          await expect(page.getByRole('alert')).toHaveCount(0);
          const mode = width === 390 ? 'mobile' : 'desktop';
          if (mode === 'mobile') await page.locator('[data-mobile-disclosure] > summary').click();
          const menu = page.locator(`[data-catalog-disclosure="${mode}"]`);
          await menu.locator(':scope > summary').click();
          const links = menu.locator(
            `[data-taxonomy-family="${family}"] [data-taxonomy-children] a`,
          );
          await expect(links).toHaveText(exposed.children.map((child) => child.name));
          const childLink = links.filter({ hasText: firstChild.name });
          await expect(childLink).toHaveAttribute(
            'href',
            `/${family}/?category=${childIds[0]}&page=1`,
          );
          await childLink.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: info.outputPath(`${family}-${width}-header.png`),
            fullPage: true,
          });
          await childLink.click();
          await expect(
            page.getByRole('checkbox', { name: firstChild.name, exact: true }),
          ).toBeChecked();
          await expect(
            page.getByRole('checkbox', { name: secondChild.name, exact: true }),
          ).not.toBeChecked();
          await expect(cards).toHaveCount(12);
        }
      });

      await page.setViewportSize({ width: 1440, height: 900 });
      const manager = await openManager(family, registry.name);
      const renamed = `Renamed ${family} child`;
      const renamedMain = `Local ${family} main`;
      await manager.getByLabel('Public main category name').fill(renamedMain);
      await manager
        .getByRole('textbox', { name: `Subcategory ${previousCount + 1} name`, exact: true })
        .fill(renamed);
      await manager
        .locator('li')
        .filter({
          has: page.getByRole('textbox', {
            name: `Subcategory ${previousCount + 2} name`,
            exact: true,
          }),
        })
        .getByRole('checkbox', { name: 'Active', exact: true })
        .uncheck();
      await saveManager(manager);
      registry = await readTaxonomy(family);
      expect(registry.children.find((child) => child.id === childIds[0])).toMatchObject({
        name: renamed,
        slug: firstChild.slug,
      });
      expect(registry.children.find((child) => child.id === childIds[1])?.status).toBe('archived');
      expect((await readProduct(batchFirst._id)).subcategoryIds).toEqual(childIds);
      const renamedPublic = await publicTaxonomy(family);
      expect(renamedPublic.name).toBe(renamedMain);
      expect(renamedPublic.children.find((child) => child.id === childIds[0])?.name).toBe(renamed);
      expect(renamedPublic.children.some((child) => child.id === childIds[1])).toBe(false);
      await page.goto(`/${family}/`);
      await expect(page.getByRole('checkbox', { name: renamed, exact: true })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: secondChild.name, exact: true })).toHaveCount(
        0,
      );
      const headerChildren = page.locator(
        `[data-catalog-disclosure="desktop"] [data-taxonomy-family="${family}"] [data-taxonomy-children] a`,
      );
      await expect(
        page.locator(
          `[data-catalog-disclosure="desktop"] [data-taxonomy-family="${family}"] [data-taxonomy-name]`,
        ),
      ).toHaveText(renamedMain);
      await expect(headerChildren).toHaveText(renamedPublic.children.map((child) => child.name));
      registry = await saveTaxonomy({
        ...registry,
        children: registry.children.map((child) => ({ ...child, status: 'archived' })),
      });
      expect((await publicTaxonomy(family)).children).toEqual([]);
      await page.goto(`/${family}/?search=${encodeURIComponent(`${e2e.runId} Taxonomy`)}`);
      await expect(page.locator('[data-product-card]')).toHaveCount(12);
      await expect(page.locator('[data-result-progress]')).toContainText('of 14 products');
      await expect(page.locator('[data-catalog-list-top]').getByRole('checkbox')).toHaveCount(0);
      await expect(headerChildren).toHaveCount(0);
      await expect(
        page.locator(`[data-catalog-disclosure="desktop"] [data-taxonomy-family="${family}"] > a`),
      ).toHaveAttribute('href', `/${family}/`);
      await expect(page.getByRole('alert')).toHaveCount(0);
    });
  }
  expect(errors).toEqual([]);
});
