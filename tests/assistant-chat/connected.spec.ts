import { type Page, expect, test } from '@playwright/test';
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const seen: string[] = [];
  errors.set(page, seen);
  page.on('pageerror', (e) => seen.push(e.message));
  await page.goto('/assistant-chat.html');
  await expect(page.getByRole('textbox', { name: 'Your question' })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Your question' }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
test('actual components communicate with BFF, database and worker across two turns', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: 'Restore conversation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prepare inquiry', exact: true })).toBeVisible();
  await send(page, 'A product question');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.locator('[data-message-role="assistant"]')).toContainText(
    'database and worker',
  );
  await send(page, 'Another question');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(2);
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(2);
  const { mkdir } = await import('node:fs/promises');
  await mkdir('output/assistant-chat', { recursive: true });
  await page
    .getByRole('dialog')
    .screenshot({ path: `output/assistant-chat/${test.info().project.name}.png` });
});
test('stop interrupts a quiet provider and a subsequent turn can complete', async ({ page }) => {
  await send(page, 'slow response');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByLabel('Answer status')).toContainText('has stopped', { timeout: 5000 });
  await send(page, 'A new question after stop');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
    'database and worker',
  );
});
test('one failed answer does not disable the whole assistant', async ({ page }) => {
  await send(page, 'fail this answer');
  await expect(page.getByLabel('Answer status')).toContainText('could not verify');
  await send(page, 'A fresh product question');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
});

test('lost acceptance reply retries the original submission through the real API', async ({
  page,
}) => {
  const bodies: string[] = [];
  await page.route('**/api/ai/v2/conversations/*/messages', async (route) => {
    bodies.push(route.request().postData() ?? '');
    const response = await route.fetch();
    if (bodies.length === 1) {
      await response.dispose();
      await route.abort('connectionreset');
    } else await route.fulfill({ response });
  });
  await send(page, 'Recover one question');
  await expect(page.getByLabel('Answer status')).toContainText('interrupted');
  await page.getByRole('button', { name: 'Resume this answer' }).click();
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(1);
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(1);
});

test('public HTTP products render images, compare, refresh and withdraw consistently', async ({
  page,
  request,
}) => {
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await send(page, 'Show headphones for company gifts');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  const cards = page.locator('[data-message-role="assistant"]').last();
  await expect(cards.getByRole('heading', { name: 'Everyday wireless headphones' })).toBeVisible();
  await expect(cards.locator('img')).toHaveCount(2);
  await expect
    .poll(() =>
      cards
        .locator('img')
        .first()
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await expect(cards.getByRole('link', { name: 'View product' }).first()).toHaveAttribute(
    'href',
    '/products/item/?id=demo-1',
  );
  await expect(cards.getByRole('button', { name: 'Prepare inquiry' })).toHaveCount(2);
  await cards.getByRole('button', { name: 'Compare', exact: true }).first().click();
  await cards.getByRole('button', { name: 'Compare', exact: true }).click();
  const comparison = page.getByRole('region', { name: 'Compare options' });
  await expect(comparison.getByRole('heading', { level: 4 })).toHaveCount(2);
  await request.post('http://127.0.0.1:62383/__fixture/control?state=updated');
  await comparison.getByRole('button', { name: 'Check current details' }).click();
  await expect(comparison).toContainText('Updated published details');
  await expect(page.getByText('Earlier details. See the updated card below.')).toBeVisible();
  await request.post('http://127.0.0.1:62383/__fixture/control?state=withdrawn');
  await comparison.getByRole('button', { name: 'Check current details' }).click();
  await expect(comparison.getByRole('heading', { level: 4 })).toHaveCount(1);
  await expect(comparison).not.toContainText('Office wireless headphones');
  await expect(
    page.getByText('This product is no longer available in the public catalog.').first(),
  ).toBeVisible();
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await page
    .getByRole('dialog')
    .screenshot({ path: `output/assistant-chat/products-${test.info().project.name}.png` });
});

test('clarification, no match, catalog failure and a fresh request all have usable responses', async ({
  page,
}) => {
  await send(page, 'I am not sure what product I want');
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
    'What type of product',
  );
  await send(page, 'Find no matching product');
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
    'could not find a published product',
  );
  await send(page, 'catalog failure');
  await expect(page.getByLabel('Answer status')).toContainText('could not verify');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await send(page, 'Show headphones');
  await expect(page.getByRole('heading', { name: 'Everyday wireless headphones' })).toBeVisible();
});

test('stopping a pending catalog read prevents its late product cards', async ({ page }) => {
  await send(page, 'catalog slow');
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByLabel('Answer status')).toContainText('has stopped');
  await page.waitForTimeout(1000);
  await expect(page.locator('[data-message-role="assistant"] section')).toHaveCount(0);
  await send(page, 'Show headphones');
  await expect(page.getByRole('heading', { name: 'Everyday wireless headphones' })).toBeVisible();
});

test('missing product images fall back without breaking the product actions', async ({ page }) => {
  await page.route('**/api/images/**', (route) => route.abort());
  await send(page, 'Show headphones');
  await expect(page.getByRole('heading', { name: 'Everyday wireless headphones' })).toBeVisible();
  await expect(page.locator('[data-message-role="assistant"] img')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View product' })).toHaveCount(2);
  await page
    .getByRole('dialog')
    .screenshot({ path: `output/assistant-chat/product-cards-${test.info().project.name}.png` });
});

test('a follow-up uses prior public cards as context and rechecks current catalog details', async ({
  page,
  request,
}) => {
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await send(page, 'Show headphones');
  await expect(page.getByRole('heading', { name: 'Everyday wireless headphones' })).toBeVisible();
  await request.post('http://127.0.0.1:62383/__fixture/control?state=updated');
  await send(page, 'Check those again');
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
    'Updated published details',
  );
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
});

async function fillInquiry(page: Page) {
  await page
    .getByRole('textbox', { name: 'Your requirement' })
    .fill('We need 500 promotional headphones. Please recommend options.');
  await page.getByRole('textbox', { name: 'Email *', exact: true }).fill('buyer@example.invalid');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Local Buyer');
  await page.getByRole('checkbox').check();
}
test('confirmed category inquiry saves once through the actual Channel intake and recovers a lost receipt', async ({
  page,
  request,
}) => {
  await page.getByRole('button', { name: 'Prepare inquiry', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm & submit' }).click();
  await expect(page.getByText('Please agree to be contacted')).toBeVisible();
  await fillInquiry(page);
  const before = (await (
    await request.get('http://127.0.0.1:62384/__fixture/state')
  ).json()) as Record<string, unknown>;
  const bodies: string[] = [];
  await page.route('**/api/ai/v2/conversations/*/inquiries', async (route) => {
    const body = route.request().postData();
    if (!body) throw new Error('Missing inquiry request body');
    bodies.push(body);
    const response = await route.fetch();
    if (bodies.length === 1) {
      expect(response.status()).toBe(200);
      await response.dispose();
      await route.abort('connectionreset');
    } else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Confirm & submit' }).click();
  await expect(page.getByText('could not confirm the result yet')).toBeVisible();
  await page.getByRole('button', { name: 'Check again now' }).click();
  await expect(page.getByLabel('Inquiry receipt')).toContainText('Your inquiry is recorded');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  const after = (await (
    await request.get('http://127.0.0.1:62384/__fixture/state')
  ).json()) as Record<string, unknown>;
  const newKeys = Object.keys(after).filter((k) => !Object.hasOwn(before, k));
  expect(newKeys.filter((k) => k.startsWith('oemProjects/'))).toHaveLength(1);
  expect(newKeys.filter((k) => k.startsWith('channelSalesSourceRegistrations/'))).toHaveLength(1);
  expect(newKeys.filter((k) => k.startsWith('channelSalesSourceDeliveries/'))).toHaveLength(1);
  await page
    .getByRole('dialog')
    .screenshot({ path: `output/assistant-chat/inquiry-${test.info().project.name}.png` });
});
test('product-card inquiry sends only its ID and preserves current public evidence', async ({
  page,
  request,
}) => {
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await send(page, 'Show headphones');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await page
    .locator('[data-message-role="assistant"]')
    .last()
    .getByRole('button', { name: 'Prepare inquiry', exact: true })
    .first()
    .click();
  await fillInquiry(page);
  await page.getByRole('button', { name: 'Confirm & submit' }).click();
  const receipt = page.getByLabel('Inquiry receipt');
  await expect(receipt).toContainText('Your inquiry is recorded');
  const text = await receipt.innerText();
  const id = /ai_[a-f0-9]{64}/.exec(text)?.[0];
  if (!id) throw new Error('Missing saved inquiry reference');
  const rows = (await (
    await request.get('http://127.0.0.1:62384/__fixture/state')
  ).json()) as Record<
    string,
    {
      assistantSubmission: {
        productReference: { requestedId: string; current: { productName: string } };
      };
    }
  >;
  expect(rows[`oemProjects/${id}`]?.assistantSubmission.productReference.requestedId).toBe(
    'demo-1',
  );
  expect(rows[`oemProjects/${id}`]?.assistantSubmission.productReference.current.productName).toBe(
    'Everyday wireless headphones',
  );
});

test('refresh_resumes_same_conversation: history comes back and a new tab starts fresh', async ({
  page,
  context,
}) => {
  await send(page, 'A product question');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await page.reload();
  await expect(page.locator('[data-message-role="visitor"]')).toHaveText(['A product question']);
  await expect(page.locator('[data-message-role="assistant"]')).toContainText(
    'database and worker',
  );
  await send(page, 'Another question');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(2);
  const fresh = await context.newPage();
  await fresh.goto('/assistant-chat.html');
  await expect(fresh.getByRole('textbox', { name: 'Your question' })).toBeVisible();
  await expect(fresh.locator('[data-message-role="visitor"]')).toHaveCount(0);
});

test('inflight_reply_resumes_without_second_model_run after a refresh mid-answer', async ({
  page,
}) => {
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/messages')) posts.push(r.postData() ?? '');
  });
  const accepted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/messages'),
  );
  await send(page, 'slow answer please');
  await accepted;
  await page.reload();
  await expect(page.locator('[data-message-role="visitor"]')).toHaveText(['slow answer please']);
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready', { timeout: 15000 });
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(1);
  await expect(page.locator('[data-message-role="assistant"]')).toContainText(
    'database and worker',
  );
  // Both page loads sent the same question with the same key; the server answers it once.
  expect(posts).toHaveLength(2);
  expect(new Set(posts).size).toBe(1);
  await page.reload();
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(1);
});

// MIU 18: a product opened from the chat replaces this page in the same tab,
// and the conversation continues there and on the way back.
const desktopLike = () => test.info().project.name !== 'mobile';
async function cardsThenMore(page: Page, request: import('@playwright/test').APIRequestContext) {
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await send(page, 'Show headphones');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  for (const question of ['A product question', 'Another product question']) {
    await send(page, question);
    await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  }
}
/** Distance of the remembered card from the top of the visible transcript. */
async function cardOffset(page: Page) {
  return page.evaluate(() => {
    const transcript = document.querySelector('[data-testid="assistant-transcript"]');
    const card = transcript?.querySelector('[data-product-id="demo-1"]');
    if (!transcript || !card) return Number.NaN;
    return card.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
  });
}
function messagePosts(page: Page) {
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/messages')) posts.push(r.postData() ?? '');
  });
  return posts;
}

test('product_link_navigates_same_tab, opens at the source card, and back_restores_previous_page_chat', async ({
  page,
  context,
  request,
}) => {
  await cardsThenMore(page, request);
  const posts = messagePosts(page);
  const tabs = context.pages().length;
  await page
    .locator('[data-message-role="assistant"]')
    .first()
    .getByRole('link', { name: 'View product' })
    .first()
    .click();
  await page.waitForURL('**/products/item/?id=demo-1');
  expect(context.pages()).toHaveLength(tabs);
  await expect(page.locator('[data-product-page="demo-1"]')).toBeVisible();
  if (desktopLike()) await expect(page.getByRole('dialog')).toBeVisible();
  else {
    // mobile_shows_continue_launcher_not_expanded: the product stays readable.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-launcher-notice]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue conversation' }).click();
  }
  await expect(page.locator('[data-message-role="visitor"]')).toHaveText([
    'Show headphones',
    'A product question',
    'Another product question',
  ]);
  // desktop_restores_expanded_at_source_card (and the same after opening on a phone).
  await expect.poll(() => cardOffset(page)).toBeLessThan(24);
  expect(await cardOffset(page)).toBeGreaterThanOrEqual(0);
  // Looking at a product never asks the model.
  expect(posts).toEqual([]);
  await page.screenshot({
    path: `output/assistant-chat/product-page-${test.info().project.name}.png`,
  });

  if (!desktopLike()) await page.getByRole('button', { name: 'Close assistant' }).click();
  await page.goBack();
  await page.waitForURL('**/assistant-chat.html');
  if (desktopLike()) await expect(page.getByRole('dialog')).toBeVisible();
  else {
    // As the visitor left it: closed, ready to continue.
    await expect(page.getByRole('button', { name: 'Continue conversation' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue conversation' }).click();
  }
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(3);
  if (desktopLike()) await expect.poll(() => cardOffset(page)).toBeLessThan(24);
  await send(page, 'One more question back here');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(4);
});

test('launcher_marks_answer_finished_while_away and navigation_mid_answer_has_no_second_model_run', async ({
  page,
  request,
}) => {
  test.setTimeout(45000);
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await send(page, 'Show headphones');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  const posts = messagePosts(page);
  const accepted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/messages'),
  );
  await send(page, 'slow answer please');
  await accepted;
  await page
    .locator('[data-message-role="assistant"]')
    .first()
    .getByRole('link', { name: 'View product' })
    .first()
    .click();
  await page.waitForURL('**/products/item/?id=demo-1');
  if (desktopLike()) {
    await expect(page.getByLabel('Answer status')).toContainText('Answer ready', {
      timeout: 15000,
    });
  } else {
    const dot = page.locator('[data-launcher-notice]');
    await expect(dot).toHaveCount(1, { timeout: 15000 });
    await expect(
      page.getByRole('button', { name: /Continue conversation · New answer/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: /Continue conversation/ }).click();
    await expect(dot).toHaveCount(0);
  }
  await expect(page.locator('[data-message-role="visitor"]')).toHaveText([
    'Show headphones',
    'slow answer please',
  ]);
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(2);
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
    'database and worker',
  );
  // Whatever each page sent was the same question under the same key.
  expect(posts.length).toBeGreaterThanOrEqual(1);
  expect(new Set(posts).size).toBe(1);
});

test('navigation_mid_save_keeps_same_submission', async ({ page, request }) => {
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await send(page, 'Show headphones');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  const answer = page.locator('[data-message-role="assistant"]').first();
  await answer.getByRole('button', { name: 'Prepare inquiry', exact: true }).first().click();
  await fillInquiry(page);
  const before = (await (
    await request.get('http://127.0.0.1:62384/__fixture/state')
  ).json()) as Record<string, unknown>;
  const bodies: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/ai/v2/conversations/*/inquiries', async (route) => {
    bodies.push(route.request().postData() ?? '');
    // The first save never reaches the server before the visitor leaves.
    if (bodies.length === 1) {
      await held;
      await route.abort('aborted').catch(() => undefined);
      return;
    }
    await route.fulfill({ response: await route.fetch() });
  });
  await page.getByRole('button', { name: 'Confirm & submit' }).click();
  await expect.poll(() => bodies.length).toBe(1);
  await answer.getByRole('link', { name: 'View product' }).first().click();
  await page.waitForURL('**/products/item/?id=demo-1');
  release();
  if (!desktopLike()) await page.getByRole('button', { name: 'Continue conversation' }).click();
  await expect(page.getByLabel('Inquiry receipt')).toContainText('Your inquiry is recorded', {
    timeout: 15000,
  });
  expect(bodies.length).toBe(2);
  expect(bodies[1]).toBe(bodies[0]);
  const after = (await (
    await request.get('http://127.0.0.1:62384/__fixture/state')
  ).json()) as Record<string, unknown>;
  const added = Object.keys(after).filter((k) => !Object.hasOwn(before, k));
  expect(added.filter((k) => k.startsWith('oemProjects/'))).toHaveLength(1);
});

test('new_tab_starts_fresh_conversation and direct_product_visit_has_single_widget', async ({
  page,
  context,
  request,
}) => {
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await send(page, 'Show headphones');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  const opened = context.waitForEvent('page');
  await page
    .locator('[data-message-role="assistant"]')
    .first()
    .getByRole('link', { name: 'View product' })
    .first()
    .click({ modifiers: ['ControlOrMeta'] });
  const tab = await opened;
  await tab.waitForURL('**/products/item/?id=demo-1');
  await expect(tab.getByRole('button', { name: 'Ask our AI' })).toHaveCount(1);
  await expect(tab.getByRole('button', { name: 'Continue conversation' })).toHaveCount(0);
  await tab.getByRole('button', { name: 'Ask our AI' }).click();
  await expect(tab.locator('[data-message-role="visitor"]')).toHaveCount(0);
  // The original tab is untouched and still in the same conversation.
  await expect(page).toHaveURL(/assistant-chat\.html$/);
  await expect(page.locator('[data-message-role="visitor"]')).toHaveText(['Show headphones']);
  await tab.close();
});

test('missing_anchor_restores_latest_with_notice', async ({ page }) => {
  await send(page, 'A product question');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('channel.ai.v2.'));
    if (!key) throw new Error('No saved conversation');
    const saved = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    sessionStorage.setItem(
      key,
      JSON.stringify({ ...saved, anchor: { messageId: 'answer:gone', productId: 'demo-1' } }),
    );
  });
  await page.reload();
  await expect(page.getByText('The product card you opened is no longer shown here')).toBeVisible();
  await expect(page.locator('[data-message-role="assistant"]').last()).toBeInViewport();
});

/** Ask on the product page, go Back, and expect the earlier page to have caught up. */
async function questionOnProductPageSurvivesBack(
  page: Page,
  request: import('@playwright/test').APIRequestContext,
  fromCache: boolean,
) {
  // Records how each page was shown, so the result says which path Back took.
  await page.addInitScript(() =>
    addEventListener('pageshow', (event) =>
      document.documentElement.setAttribute('data-from-cache', String(event.persisted)),
    ),
  );
  await page.reload();
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await send(page, 'Show headphones');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await page.getByRole('link', { name: 'View product' }).first().click();
  await page.waitForURL('**/products/item/?id=demo-1');
  if (!desktopLike()) await page.getByRole('button', { name: 'Continue conversation' }).click();
  await send(page, 'Asked on the product page');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await page.goBack();
  await page.waitForURL('**/assistant-chat.html');
  await expect(page.locator('html')).toHaveAttribute('data-from-cache', String(fromCache));
  // Left open on the product page, so it comes back open on every screen size.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('[data-message-role="visitor"]')).toHaveText([
    'Show headphones',
    'Asked on the product page',
  ]);
  await expect(page.locator('[data-message-role="assistant"]').last()).toBeInViewport();
}
test('a question asked on the product page is there after Back, at the latest message', async ({
  page,
  request,
}) => {
  await questionOnProductPageSurvivesBack(page, request, false);
});
