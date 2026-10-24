import { type Page, type Response, expect } from '@playwright/test';

export async function expectPageAllowsIndexing(page: Page, response: Response | null) {
  expect(response, 'An actual page response is required').not.toBeNull();
  const rules = await page
    .locator('meta')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) =>
          ['robots', 'googlebot', 'bingbot'].includes(
            (node.getAttribute('name') ?? '').toLowerCase(),
          ),
        )
        .map((node) => node.getAttribute('content') ?? ''),
    );
  const headers = await response?.allHeaders();
  rules.push(headers?.['x-robots-tag'] ?? '');
  // An omitted policy allows indexing; explicit restrictions still fail.
  for (const rule of rules)
    expect(rule, 'The public page must allow indexing').not.toMatch(/\b(?:noindex|none)\b/i);
}
