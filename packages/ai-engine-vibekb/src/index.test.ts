import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateMessages } from '@vibelingan-channel/ai-engine/budget';
import {
  type EngineEvent,
  type EngineRunRequest,
  PRODUCT_ANSWER_PROFILE_ID,
  QUESTION_BUDGET_EXHAUSTED,
} from '@vibelingan-channel/ai-engine/port';
import { boundedFetch } from './http.ts';
import { PublicKnowledge, VibeKbEngine } from './index.ts';

const request: EngineRunRequest = {
  operationId: 'op-1',
  conversationRef: 'opaque',
  profileId: 'channel-products-v1',
  locale: 'en',
  turns: [{ role: 'visitor', text: 'Who is Diversity?' }],
  limits: { maxDeliveredOutputUnits: 4096, maxStreamDurationMs: 3000, maxToolCalls: 6 },
};
function setup(
  options: {
    foreign?: boolean;
    secretHit?: boolean;
    plans?: string[];
    delay?: boolean;
    finishReason?: string;
    thinkingMode?: 'enabled' | 'disabled';
    usage?: Array<{ prompt_tokens: number; completion_tokens: number } | undefined>;
    documentText?: string;
  } = {},
) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const plans = [
    ...(options.plans ?? [
      '{"kind":"knowledge","query":"Diversity"}',
      '{"kind":"answer","text":"We are a manufacturing partner."}',
    ]),
  ];
  const api: typeof fetch = async (url, init) => {
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    if (String(url).includes('model.invalid')) {
      if (options.delay)
        return new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        );
      const usage = options.usage?.shift();
      return Response.json({
        choices: [
          { finish_reason: options.finishReason ?? 'stop', message: { content: plans.shift() } },
        ],
        ...(usage ? { usage } : {}),
      });
    }
    const params = body.params as
      | { name?: string; arguments?: Record<string, unknown> }
      | undefined;
    let result: unknown;
    if (body.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'kb', version: '1' },
      };
    else if (body.method === 'notifications/initialized')
      return new Response(null, { status: 202 });
    else if (body.method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments;
      if (name !== 'get_document') assert.equal(args?.workspace, '2');
      const publicRow = {
        id: 12,
        title: 'Public company',
        tags: ['对外公开'],
        workspace_id: options.foreign ? 99 : 2,
        content: options.documentText ?? 'We are a manufacturing partner.',
      };
      const unapproved = {
        id: 13,
        title: 'Unapproved public label',
        tags: ['对外公开'],
        workspace_id: 2,
        content: 'UNAPPROVED CANARY',
      };
      const data =
        name === 'get_document'
          ? args?.document_id === 13
            ? unapproved
            : publicRow
          : name === 'list_documents'
            ? { documents: [publicRow] }
            : {
                results: options.secretHit
                  ? [
                      { id: 114, title: 'Internal', tags: ['内部'], snippet: 'PRIVATE CANARY' },
                      unapproved,
                      publicRow,
                    ]
                  : [publicRow],
              };
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else throw new Error('Unexpected MCP method');
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  const knowledge = {
    url: 'https://kb.invalid/mcp',
    apiKey: 'dummy',
    workspaceId: 2,
    publicDocumentIds: [12],
    publicTag: '对外公开',
    sourcePrefix: 'channelkb',
    fetch: api,
  };
  const engine = new VibeKbEngine({
    modelBaseUrl: 'https://model.invalid/v1',
    model: 'model',
    modelApiKey: 'dummy',
    ...(options.thinkingMode ? { thinkingMode: options.thinkingMode } : {}),
    knowledge,
    fetch: api,
    provenance: {
      kind: 'git',
      commit: 'a'.repeat(40),
      repository: 'local-test',
      configDigest: `sha256:${'b'.repeat(64)}`,
    },
  });
  return { engine, calls, knowledge };
}
test('official MCP client performs real handshake and fixed scoped tools; model sees only approved evidence', async () => {
  const f = setup({ secretHit: true });
  const handle = await f.engine.createRun(request, new AbortController().signal);
  const events = [];
  for await (const e of f.engine.streamRun(handle, new AbortController().signal))
    if (e.type !== 'activity' && e.type !== 'usage') events.push(e);
  assert.equal(events[0]?.type, 'final');
  if (events[0]?.type !== 'final') throw new Error('missing final');
  assert.equal(events[0].citations[0]?.sourceId, 'channelkb/vibekb/12');
  assert.equal(events[0].citations.length, 1);
  assert.ok(f.calls.some((c) => c.body.method === 'initialize'));
  const model = f.calls.filter((c) => c.url.includes('model.invalid'));
  assert.equal(model.length, 2);
  assert.ok(JSON.stringify(model[1]).includes('manufacturing partner'));
  assert.ok(!JSON.stringify(model).includes('PRIVATE CANARY'));
  assert.ok(!JSON.stringify(model).includes('UNAPPROVED CANARY'));
  assert.equal(await f.engine.cancelRun(handle), 'unknown_run');
});
test('changed document workspace never reaches the model, even when an approved ID was returned', async () => {
  const f = setup({ foreign: true });
  const h = await f.engine.createRun(request, new AbortController().signal);
  await assert.rejects(async () => {
    for await (const _ of f.engine.streamRun(h, new AbortController().signal)) {
    }
  });
  assert.equal(f.calls.filter((c) => c.url.includes('model.invalid')).length, 1);
});
test('empty scope is refused; insufficient budget cannot call the next tool', async () => {
  const f = setup();
  assert.throws(() => new PublicKnowledge({ ...f.knowledge, publicDocumentIds: [] }));
  await assert.rejects(
    new PublicKnowledge(f.knowledge).search('company', new AbortController().signal, {
      remaining: 0,
    }),
  );
  assert.ok(!f.calls.some((c) => c.body.method === 'tools/call'));
});
test('stop aborts a quiet real-model request and consumes no later knowledge calls', async () => {
  const f = setup({ delay: true });
  const h = await f.engine.createRun(request, new AbortController().signal);
  const stream = f.engine.streamRun(h, new AbortController().signal)[Symbol.asyncIterator]();
  const next = stream.next();
  await next;
  const pending = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await f.engine.cancelRun(h), 'stopped');
  await assert.rejects(pending);
  assert.equal(f.calls.length, 1);
});
test('repeated knowledge plans cannot exceed fixed rounds or tool budget', async () => {
  const f = setup({ plans: Array(3).fill('{"kind":"knowledge","query":"company"}') });
  const h = await f.engine.createRun(
    { ...request, limits: { ...request.limits, maxToolCalls: 10 } },
    new AbortController().signal,
  );
  await assert.rejects(async () => {
    for await (const _ of f.engine.streamRun(h, new AbortController().signal)) {
    }
  });
  assert.equal(f.calls.filter((c) => c.url.includes('model.invalid')).length, 3);
});
test('provider redirects, arbitrary destinations and oversized bodies are rejected', async () => {
  const url = new URL('https://model.invalid/v1/chat/completions');
  let called = false;
  const f: typeof fetch = async () => {
    called = true;
    return new Response('12345');
  };
  await assert.rejects(boundedFetch(url, f)('https://evil.invalid/'));
  assert.equal(called, false);
  await assert.rejects(async () => (await boundedFetch(url, f, 4)(url)).text());
  const redirect: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    return new Response(null, { status: 302, headers: { Location: 'https://evil.invalid' } });
  };
  await assert.rejects(boundedFetch(url, redirect)(url));
});

test('truncated model output cannot become a completed plan even when its JSON parses', async () => {
  const f = setup({ plans: ['{"kind":"search","query":"headphones"}'], finishReason: 'length' });
  const h = await f.engine.createRun(request, new AbortController().signal);
  await assert.rejects(async () => {
    for await (const _ of f.engine.streamRun(h, new AbortController().signal)) {
    }
  });
});

test('aborting before stream releases local run capacity after a failed handle write', async () => {
  const f = setup();
  for (let i = 0; i < 140; i++) {
    const controller = new AbortController();
    const handle = await f.engine.createRun(
      { ...request, operationId: `not-streamed-${i}` },
      controller.signal,
    );
    controller.abort();
    assert.equal(await f.engine.cancelRun(handle), 'unknown_run');
  }
  assert.equal(f.calls.length, 0);
});

test('website thinking mode is server-configured per request; omitted modes remain compatible', async () => {
  for (const thinkingMode of [undefined, 'disabled'] as const) {
    const f = setup(thinkingMode ? { thinkingMode } : {});
    const h = await f.engine.createRun(request, AbortSignal.timeout(3000));
    for await (const _ of f.engine.streamRun(h, AbortSignal.timeout(3000))) {
    }
    for (const call of f.calls.filter((c) => c.url.includes('model.invalid')))
      assert.deepEqual(call.body.thinking, thinkingMode ? { type: 'disabled' } : undefined);
  }
});

async function drain(engine: VibeKbEngine, run: EngineRunRequest) {
  const handle = await engine.createRun(run, new AbortController().signal);
  const events: EngineEvent[] = [];
  for await (const e of engine.streamRun(handle, new AbortController().signal))
    if (e.type !== 'activity') events.push(e);
  return events;
}

test('every model call reports its usage, from the provider when it says', async () => {
  const f = setup({ usage: [{ prompt_tokens: 900, completion_tokens: 20 }, undefined] });
  const events = await drain(f.engine, request);
  const usage = events.flatMap((e) => (e.type === 'usage' ? [e.usage] : []));
  assert.equal(usage.length, 2);
  assert.deepEqual(usage[0], { inputTokens: 900, outputTokens: 20 });
  assert.equal(usage[1]?.estimated, true);
  const second = f.calls.filter((c) => c.url.includes('model.invalid'))[1];
  assert.equal(
    usage[1]?.inputTokens,
    estimateMessages((second?.body.messages ?? []) as Array<{ content: string }>),
  );
  assert.equal(events.at(-1)?.type, 'final');
});

test('an unusable answer still records what the provider billed, then fails', async () => {
  for (const finishReason of ['length', 'content_filter']) {
    const f = setup({
      plans: ['{"kind":"answer","text":"Trunc'],
      finishReason,
      usage: [{ prompt_tokens: 1000, completion_tokens: 1200 }],
    });
    const handle = await f.engine.createRun(request, new AbortController().signal);
    const usage: unknown[] = [];
    await assert.rejects(
      async () => {
        for await (const e of f.engine.streamRun(handle, new AbortController().signal))
          if (e.type === 'usage') usage.push(e.usage);
          else assert.notEqual(e.type, 'final');
      },
      { name: 'EngineError', category: 'invalid_request' },
    );
    assert.deepEqual(usage, [{ inputTokens: 1000, outputTokens: 1200 }], finishReason);
  }
});

test('an unusable answer without provider usage is estimated from what was sent', async () => {
  const f = setup({ plans: ['{"kind":"answer","text":"Trunc'], finishReason: 'length' });
  const handle = await f.engine.createRun(request, new AbortController().signal);
  const usage: Array<{ inputTokens: number; estimated?: boolean }> = [];
  await assert.rejects(async () => {
    for await (const e of f.engine.streamRun(handle, new AbortController().signal))
      if (e.type === 'usage') usage.push(e.usage);
  });
  const sent = f.calls.find((c) => c.url.includes('model.invalid'));
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.estimated, true);
  assert.equal(
    usage[0]?.inputTokens,
    estimateMessages((sent?.body.messages ?? []) as Array<{ content: string }>),
  );
});

test('a provider body with no answer choice records no invented usage', async () => {
  const f = setup();
  const engine = new VibeKbEngine({
    modelBaseUrl: 'https://model.invalid/v1',
    model: 'model',
    modelApiKey: 'dummy',
    knowledge: f.knowledge,
    fetch: async () => Response.json({ error: { message: 'overloaded' } }),
    provenance: {
      kind: 'git',
      commit: 'a'.repeat(40),
      repository: 'local-test',
      configDigest: `sha256:${'b'.repeat(64)}`,
    },
  });
  const handle = await engine.createRun(request, new AbortController().signal);
  const usage: unknown[] = [];
  await assert.rejects(async () => {
    for await (const e of engine.streamRun(handle, new AbortController().signal))
      if (e.type === 'usage') usage.push(e.usage);
  });
  assert.deepEqual(usage, []);
});

test('the requirement summary is sent as data ahead of the dialogue', async () => {
  const f = setup({ plans: ['{"kind":"answer","text":"Noted."}'] });
  await drain(f.engine, { ...request, memory: 'Requirements DATA: {"quantity":"700"}' });
  const messages = f.calls[0]?.body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, 'system');
  assert.deepEqual(messages[1], { role: 'user', content: 'Requirements DATA: {"quantity":"700"}' });
  assert.equal(messages.at(-1)?.content, 'Who is Diversity?');
});

test('long retrieved documents are cut so a call stays under its input ceiling', async () => {
  const f = setup({
    documentText: `Manufacturing partner. ${'Long public detail. '.repeat(1500)}`,
  });
  const question = `Tell me about your factory ${'please '.repeat(200)}`;
  await drain(f.engine, {
    ...request,
    turns: [{ role: 'visitor', text: question }],
    memory: 'Requirements DATA: {"quantity":"700"}',
    limits: { ...request.limits, maxInputTokens: 3_000 },
  });
  const model = f.calls.filter((c) => c.url.includes('model.invalid'));
  const answer = model[1]?.body.messages as Array<{ role: string; content: string }>;
  assert.ok(estimateMessages(answer) <= 3_000);
  assert.ok(
    answer.some((m) => m.content === question),
    'the current message is whole',
  );
  assert.ok(answer.some((m) => m.content.includes('"quantity":"700"')));
  assert.ok(
    answer.at(-1)?.content.includes('Manufacturing partner.'),
    'evidence was cut, not dropped',
  );
});

test('the answer after the documents is asked for in the visitor’s language', async () => {
  const lastSent = async (text: string) => {
    const f = setup();
    await drain(f.engine, { ...request, turns: [{ role: 'visitor', text }] });
    const model = f.calls.filter((c) => c.url.includes('model.invalid'));
    const sent = model[1]?.body.messages as Array<{ content: string }>;
    return sent.at(-1)?.content ?? '';
  };
  const english = await lastSent('What does your OEM process look like?');
  assert.match(english, /knowledge DATA/);
  assert.match(english, /It is not Chinese, so do not write Chinese/);
  assert.match(await lastSent('你们的 OEM 流程是怎样的？'), /Answer the visitor in Chinese\./);
});

test('the catalog answer is asked for after the catalog DATA, in the visitor’s language', async () => {
  const f = setup({ plans: ['{"kind":"answer","text":"两款可选。"}'] });
  await drain(f.engine, {
    ...request,
    profileId: PRODUCT_ANSWER_PROFILE_ID,
    turns: [
      { role: 'visitor', text: '有什么无线耳机推荐？' },
      {
        role: 'assistant',
        text: 'Current published catalog DATA.',
        publicCatalog: { products: [], unavailableProductIds: [] },
      },
    ],
    limits: { ...request.limits, maxToolCalls: 0 },
  });
  const sent = f.calls.find((c) => c.url.includes('model.invalid'))?.body.messages as Array<{
    role: string;
    content: string;
  }>;
  assert.equal(sent.at(-2)?.role, 'assistant', 'the catalog DATA comes first');
  assert.deepEqual(sent.at(-1), {
    role: 'user',
    content:
      'Return only {"kind":"answer","text":"..."} from the catalog DATA above. Answer the visitor in Chinese.',
  });
});

test('a question that has spent its input budget stops before the next call', async () => {
  const f = setup({ usage: [{ prompt_tokens: 2_000, completion_tokens: 10 }] });
  const events = await drain(f.engine, {
    ...request,
    limits: { ...request.limits, questionInputTokens: 2_300 },
  });
  assert.equal(f.calls.filter((c) => c.url.includes('model.invalid')).length, 1);
  assert.deepEqual(events.at(-1), {
    type: 'error',
    category: 'quota',
    retriable: false,
    safeDetail: QUESTION_BUDGET_EXHAUSTED,
  });
});

test('a requirement update sent with a knowledge step reaches the final plan', async () => {
  const f = setup({
    plans: [
      '{"kind":"knowledge","query":"Diversity","need":{"quantity":"700"}}',
      '{"kind":"answer","text":"We are a manufacturing partner."}',
    ],
  });
  const final = (await drain(f.engine, request)).at(-1);
  assert.equal(final?.type, 'final');
  if (final?.type !== 'final') return;
  assert.deepEqual(JSON.parse(final.text), {
    kind: 'answer',
    text: 'We are a manufacturing partner.',
    need: { quantity: '700' },
  });
});
