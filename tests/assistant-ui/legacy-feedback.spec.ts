import { type Page, type Route, expect, test } from '@playwright/test';

function gate() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

async function events(route: Route, ...body: Array<Record<string, unknown>>) {
  await route.fulfill({
    contentType: 'text/event-stream',
    body: body.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  });
}

const conversation = {
  conversationId: 'legacy-test-conversation',
  credential: 'local-fixture-only',
  expiresAt: '2099-01-01T00:00:00Z',
};
const accepted = { messageId: 'message-1', runId: 'run-1', disposition: 'started' };

async function open(page: Page) {
  await page.goto('/assistant-legacy-preview.html');
  await page.getByRole('button', { name: 'Ask our AI' }).click();
  await page
    .getByRole('textbox', { name: 'Your question' })
    .fill('What does your company provide?');
}

test('Thinking appears during delayed conversation creation and submission; final-only text renders', async ({
  page,
}) => {
  const create = gate();
  const submit = gate();
  let postStarted = false;
  await page.route('**/api/ai-test/api/ai/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/conversations')) {
      await create.ready;
      return json(route, conversation);
    }
    if (path.endsWith('/messages')) {
      postStarted = true;
      await submit.ready;
      return json(route, accepted);
    }
    return events(route, { type: 'final', sequence: 1, text: 'We provide OEM electronics.' });
  });
  await open(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('assistant-activity')).toContainText('Thinking…', { timeout: 100 });
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(0);
  await page.getByRole('dialog').screenshot({
    path: `output/assistant-ui/screens/${test.info().project.name}-legacy-thinking.png`,
  });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  create.release();
  await expect.poll(() => postStarted).toBe(true);
  await expect(page.getByTestId('assistant-activity')).toContainText('Thinking…');
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(0);
  submit.release();
  await expect(page.locator('[data-message-role="assistant"]')).toHaveText(
    'We provide OEM electronics.',
  );
  await expect(page.getByTestId('assistant-activity')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
});

test('a failed answer keeps the composer: the visitor can ask again and still reach the team', async ({
  page,
}) => {
  let asked = 0;
  await page.route('**/api/ai-test/api/ai/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/conversations')) return json(route, conversation);
    if (path.endsWith('/messages')) {
      asked += 1;
      return json(route, { ...accepted, messageId: `message-${asked}`, runId: `run-${asked}` });
    }
    return asked === 1
      ? events(route, { type: 'run.failed', sequence: 1, category: 'transient' })
      : events(route, { type: 'final', sequence: 2, text: 'We provide OEM electronics.' });
  });
  await open(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('I could not answer that just now.')).toBeVisible();
  // The way to the team is offered, and the question box is still there.
  await expect(page.getByRole('link', { name: 'Send your project to our team' })).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Your question' });
  await expect(box).toBeVisible();
  await expect(box).toBeEnabled();
  await box.fill('What does your company provide?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-message-role="assistant"]')).toHaveText(
    'We provide OEM electronics.',
  );
  // Once the next question is under way the failure notice's link is gone.
  await expect(page.getByRole('link', { name: 'Send your project to our team' })).toHaveCount(0);
  await expect(box).toBeVisible();
});

test('a network failure while sending also keeps the composer', async ({ page }) => {
  await page.route('**/api/ai-test/api/ai/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/conversations')) return json(route, conversation);
    return route.abort('failed');
  });
  await open(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('The assistant could not be reached just now.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your question' })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Send your project to our team' })).toBeVisible();
});

test('a rejected saved credential renews once and starts the new event cursor at zero', async ({
  page,
}) => {
  await page.addInitScript((saved) => {
    sessionStorage.setItem('channel.ai.conversation.v1', JSON.stringify(saved));
    sessionStorage.setItem('channel.ai.sequence.v1', '87');
  }, conversation);
  const calls = { rejected: 0, create: 0, accepted: 0, cursors: [] as string[] };
  const question = 'what product do you have? Top wirless headphones';
  await page.route('**/api/ai-test/api/ai/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/conversations')) {
      calls.create += 1;
      return json(route, { ...conversation, conversationId: 'renewed-conversation' });
    }
    if (path.includes(`/${conversation.conversationId}/messages`)) {
      calls.rejected += 1;
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } });
    }
    if (path.endsWith('/renewed-conversation/messages')) {
      calls.accepted += 1;
      expect(route.request().postDataJSON().message).toBe(question);
      return json(route, accepted);
    }
    calls.cursors.push(route.request().headers()['last-event-id'] ?? 'missing');
    return events(route, { type: 'final', sequence: 1, text: 'Here are our wireless headphones.' });
  });
  await open(page);
  await page.getByRole('textbox', { name: 'Your question' }).fill(question);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-message-role="assistant"]')).toHaveText(
    'Here are our wireless headphones.',
  );
  expect(calls).toEqual({ rejected: 1, create: 1, accepted: 1, cursors: ['0'] });
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Your question' })).toBeEnabled();
});

test('a credential that expires while the tab stays open is replaced before sending', async ({
  page,
}) => {
  await page.clock.install();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await page.addInitScript(
    (saved) => {
      sessionStorage.setItem('channel.ai.conversation.v1', JSON.stringify(saved));
      sessionStorage.setItem('channel.ai.sequence.v1', '87');
    },
    { ...conversation, expiresAt },
  );
  const posts: string[] = [];
  let created = 0;
  await page.route('**/api/ai-test/api/ai/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/conversations')) {
      created += 1;
      return json(route, { ...conversation, conversationId: 'fresh-conversation' });
    }
    if (path.endsWith('/messages')) {
      posts.push(path);
      return json(route, accepted);
    }
    expect(route.request().headers()['last-event-id']).toBe('0');
    return events(route, { type: 'final', sequence: 1, text: 'Fresh session answer.' });
  });
  await open(page);
  await page.clock.fastForward(120_000);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-message-role="assistant"]')).toHaveText('Fresh session answer.');
  expect(created).toBe(1);
  expect(posts).toEqual(['/api/ai-test/api/ai/conversations/fresh-conversation/messages']);
});

for (const status of [401, 429, 503]) {
  test(`message HTTP ${status} recovery is bounded and does not replay uncertain submissions`, async ({
    page,
  }) => {
    let creates = 0;
    let posts = 0;
    await page.route('**/api/ai-test/api/ai/**', async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/conversations')) {
        creates += 1;
        return json(route, { ...conversation, conversationId: `conversation-${creates}` });
      }
      posts += 1;
      return route.fulfill({
        status,
        json: { error: { code: status === 401 ? 'UNAUTHORIZED' : 'UNAVAILABLE' } },
      });
    });
    await open(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('The assistant could not be reached just now.')).toBeVisible();
    expect(creates).toBe(status === 401 ? 2 : 1);
    expect(posts).toBe(status === 401 ? 2 : 1);
    await expect(page.getByRole('textbox', { name: 'Your question' })).toBeEnabled();
  });
}

test('an accepted message is not resubmitted when the event stream returns 401', async ({
  page,
}) => {
  let creates = 0;
  let posts = 0;
  await page.route('**/api/ai-test/api/ai/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/conversations')) {
      creates += 1;
      return json(route, conversation);
    }
    if (path.endsWith('/messages')) {
      posts += 1;
      return json(route, accepted);
    }
    return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } });
  });
  await open(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('The assistant could not be reached just now.')).toBeVisible();
  expect({ creates, posts }).toEqual({ creates: 1, posts: 1 });
});

test('received activity and partial text display before the final answer, in one answer bubble', async ({
  page,
}) => {
  const firstToken = gate();
  const final = gate();
  let connections = 0;
  await page.route('**/api/ai-test/api/ai/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/conversations')) return json(route, conversation);
    if (path.endsWith('/messages')) return json(route, accepted);
    connections += 1;
    if (connections === 1)
      return events(route, { type: 'tool.progress', sequence: 1, action: 'knowledge_search' });
    if (connections === 2) {
      await firstToken.ready;
      return events(route, { type: 'token', sequence: 2, text: 'We provide ' });
    }
    await final.ready;
    return events(
      route,
      { type: 'token', sequence: 3, text: 'OEM electronics.' },
      { type: 'final', sequence: 4, text: 'We provide OEM electronics.' },
    );
  });
  await open(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('assistant-activity')).toContainText(
    'Checking company information…',
  );
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(0);
  firstToken.release();
  const answer = page.locator('[data-message-role="assistant"]');
  await expect(answer).toHaveCount(1);
  await expect(answer).toHaveText('We provide');
  await expect(page.getByTestId('assistant-activity')).toContainText('Writing your answer…');
  await page.getByRole('dialog').screenshot({
    path: `output/assistant-ui/screens/${test.info().project.name}-legacy-writing.png`,
  });
  final.release();
  await expect(answer).toHaveCount(1);
  await expect(answer).toHaveText('We provide OEM electronics.');
  await expect(page.getByTestId('assistant-activity')).toHaveCount(0);
});

test('closing during creation only hides the panel; reopening preserves the pending answer', async ({
  page,
}) => {
  const create = gate();
  let messagePosts = 0;
  await page.route('**/api/ai-test/api/ai/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/conversations')) {
      await create.ready;
      return json(route, conversation);
    }
    if (path.endsWith('/messages')) {
      messagePosts += 1;
      return json(route, accepted);
    }
    return events(route, { type: 'final', sequence: 1, text: 'Answer kept while closed.' });
  });
  await open(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('assistant-activity')).toBeVisible();
  await page.getByRole('button', { name: 'Close assistant', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask our AI' }).click();
  await expect(page.getByTestId('assistant-activity')).toContainText('Thinking…');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  create.release();
  await expect(page.locator('[data-message-role="assistant"]')).toHaveText(
    'Answer kept while closed.',
  );
  expect(messagePosts).toBe(1);
});

for (const cancelled of [true, false]) {
  test(`accepted answer stops receiving only when the server accepts cancellation=${cancelled}`, async ({
    page,
  }) => {
    const completion = gate();
    let cancellations = 0;
    await page.route('**/api/ai-test/api/ai/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/conversations')) return json(route, conversation);
      if (path.endsWith('/messages')) return json(route, accepted);
      if (path.endsWith('/cancel')) {
        cancellations += 1;
        return json(route, { cancelled });
      }
      await completion.ready;
      return events(route, { type: 'final', sequence: 1, text: 'Completed answer.' });
    });
    await open(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    if (cancelled) {
      await expect(page.getByRole('textbox', { name: 'Your question' })).toBeEnabled();
      await expect(page.getByTestId('assistant-activity')).toHaveCount(0);
      completion.release();
      await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(0);
    } else {
      await expect(page.locator('[data-message-role="status"]')).toContainText(
        'I could not confirm stopping',
      );
      await expect(page.getByRole('textbox', { name: 'Your question' })).toBeDisabled();
      completion.release();
      await expect(page.locator('[data-message-role="assistant"]')).toHaveText('Completed answer.');
      await expect(page.getByRole('textbox', { name: 'Your question' })).toBeEnabled();
    }
    expect(cancellations).toBe(1);
  });
}
