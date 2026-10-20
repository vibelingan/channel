import { expect, test } from '@playwright/test';

test('Products readiness default, explicit All, reload and history keep every issue queue accessible', async ({
  page,
}) => {
  const user = { id: 'admin', email: 'admin@example.test', username: 'Admin', role: 'admin' };
  await page.addInitScript((account) => {
    if (!location.pathname.startsWith('/admin')) return;
    localStorage.setItem('channel.token', 'synthetic-readiness-token');
    localStorage.setItem('channel.user', JSON.stringify(account));
  }, user);
  const queries: Array<Record<string, unknown>> = [];
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON();
    const data =
      body.action === 'me'
        ? { user }
        : body.action === 'list'
          ? { items: [], total: 0, page: body.data?.page ?? 1, pageSize: body.data?.pageSize ?? 20 }
          : null;
    if (body.action === 'list' && body.data?.collection === 'products' && body.data.pageSize !== 1)
      queries.push(body.data);
    await route.fulfill({
      status: data ? 200 : 400,
      contentType: 'application/json',
      body: JSON.stringify(
        data
          ? { ok: true, data }
          : { ok: false, error: { code: 'BAD_REQUEST', message: 'Unused' } },
      ),
    });
  });
  const defaultScope = process.env.PUBLIC_CATALOG_READY_DEFAULT === '1' ? 'normal' : 'all';
  await page.goto('/admin?productFamily=misc&keep=yes');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.catalogReadiness).toBe(defaultScope);
  const select = page.getByRole('combobox', { name: 'Check status', exact: true });
  for (const [scope, label] of [
    ['issues', 'Data issues'],
    ['preparing', 'Preparing'],
    ['unchecked', 'Unchecked'],
    ['all', 'All check statuses'],
  ] as const) {
    await select.click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await expect.poll(() => queries.at(-1)?.catalogReadiness).toBe(scope);
    expect(new URL(page.url()).searchParams.get('keep')).toBe('yes');
    expect(new URL(page.url()).searchParams.get('productFamily')).toBe('misc');
    if (scope === 'all' && defaultScope === 'normal')
      expect(new URL(page.url()).searchParams.get('checkStatus')).toBe('all');
  }
  await page.reload();
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await expect(select).toContainText('All check statuses');
  await expect.poll(() => queries.at(-1)?.catalogReadiness).toBe('all');
  await page.goBack();
  await expect(select).toContainText('Unchecked');
  await expect.poll(() => queries.at(-1)?.catalogReadiness).toBe('unchecked');
});
