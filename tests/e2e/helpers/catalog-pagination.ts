import type { Page } from '@playwright/test';

type PaginationLabel = `Page ${number}` | 'Previous page' | 'Next page';

export function catalogPagination(page: Page) {
  return page.getByRole('navigation', { name: 'Pagination', exact: true });
}

export function catalogPageLink(page: Page, label: PaginationLabel) {
  return catalogPagination(page).getByRole('link', { name: label, exact: true });
}

export function catalogPageControl(page: Page, label: PaginationLabel) {
  return catalogPagination(page).locator(`[aria-label="${label}"]`);
}

export function catalogPageNumber(url: URL) {
  const pathPage = /\/page\/([1-9]\d*)\/?$/.exec(url.pathname)?.[1];
  return Number(pathPage ?? url.searchParams.get('page') ?? '1');
}
