import { strict as assert } from 'node:assert';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { EngineCitation, EngineEvent, EngineRunRequest } from '@vibelingan-channel/ai-engine';
import { AnythingLlmEngine, estimateOutputUnits } from './engine.ts';

type Scripted = { status?: number; frames?: unknown[]; delayMs?: number; raw?: string };

/** A stand-in vendor that emits exactly the SSE frames a test needs. */
function vendor(script: Scripted): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/api/v1/auth') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authenticated: true }));
      return;
    }
    if (script.status && script.status >= 400) {
      res.writeHead(script.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'scripted failure' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (script.raw !== undefined) {
      res.end(script.raw);
      return;
    }
    let i = 0;
    const frames = script.frames ?? [];
    const tick = () => {
      if (i >= frames.length) return void res.end();
      res.write(`data: ${JSON.stringify(frames[i++])}\n\n`);
      setTimeout(tick, script.delayMs ?? 1);
    };
    tick();
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

const REQUEST: EngineRunRequest = {
  operationId: '00000000-0000-4000-8000-000000000001',
  conversationRef: 'conv-1',
  turns: [{ role: 'visitor', text: 'What is your MOQ?' }],
  profileId: 'public-sales-v1',
  locale: 'en-US',
  limits: { maxDeliveredOutputUnits: 500, maxStreamDurationMs: 5_000, maxToolCalls: 0 },
};

async function collect(script: Scripted, request: EngineRunRequest = REQUEST) {
  const { server, baseUrl } = await vendor(script);
  const engine = new AnythingLlmEngine({
    baseUrl,
    apiKey: 'test-key',
    workspaceSlug: 'ws',
    engineVersion: '1.0.0-test',
    citationsVerified: true,
  });
  const events: EngineEvent[] = [];
  try {
    const controller = new AbortController();
    const handle = await engine.createRun(request, controller.signal);
    for await (const event of engine.streamRun(handle, controller.signal)) events.push(event);
  } finally {
    server.close();
  }
  return events;
}

const chunk = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'textResponseChunk',
  textResponse: text,
  sources: [],
  close: false,
  error: false,
  ...extra,
});

test('capabilities describe what this vendor family actually guarantees', () => {
  const engine = new AnythingLlmEngine({
    baseUrl: 'http://unused',
    allowInsecureRemoteHttp: true,
    apiKey: 'k',
    workspaceSlug: 'ws',
    engineVersion: '1.0.0-test',
    citationsVerified: true,
  });
  const c = engine.capabilities;
  assert.equal(c.supportsStop, true, 'the owner can always abort its own connection');
  assert.equal(c.supportsOutOfBandStop, false, 'chat-completions style APIs have no stop-by-id');
  assert.equal(c.supportsCitations, true);
  assert.equal(c.supportsIdempotentCreate, false);
  assert.equal(c.supportsRunLookupByOperationId, false);
});

test('tokens stream through with the model reasoning removed', async () => {
  const events = await collect({
    frames: [
      chunk('<think>The user asks '),
      chunk('about MOQ.</think>Our MOQ '),
      chunk('is 500 units.'),
      { type: 'finalizeResponseStream', close: true, error: false },
    ],
  });
  const text = events
    .filter((e) => e.type === 'token')
    .map((e) => (e as { text: string }).text)
    .join('');
  assert.equal(text, 'Our MOQ is 500 units.');
  assert.ok(!text.includes('<think>'), 'reasoning tag leaked to the caller');
  assert.ok(!text.includes('The user asks'), 'model deliberation leaked to the caller');
});

test('sources become citations, and the final event carries them all', async () => {
  const events = await collect({
    frames: [
      chunk('MOQ is 500.', {
        sources: [
          {
            id: 'doc-1',
            title: 'en-us-headphones.txt',
            docSource: '/headphones',
            text: 'MOQ from 500 units',
            published: '8/19/2026, 7:08:00 AM',
          },
        ],
      }),
      { type: 'finalizeResponseStream', close: true, error: false },
    ],
  });
  const citation = events.find((e) => e.type === 'citation');
  assert.ok(citation, 'no citation emitted');
  const c = (citation as { citation: EngineCitation }).citation;
  // The page, not the chunk — see the dedup test below.
  assert.equal(c.sourceId, 'en-us-headphones.txt');
  assert.equal(c.url, '/headphones');
  assert.equal(c.snippet, 'MOQ from 500 units');
  assert.ok(!Number.isNaN(Date.parse(c.retrievedAt)), 'retrievedAt is not an ISO timestamp');

  const final = events.at(-1) as { type: string; text: string; citations: unknown[] };
  assert.equal(final.type, 'final');
  assert.equal(final.text, 'MOQ is 500.');
  assert.equal(final.citations.length, 1);
});

test('the same source cited twice is emitted once', async () => {
  const source = { id: 'doc-1', title: 't', docSource: '/x', text: 'y' };
  const events = await collect({
    frames: [
      chunk('a', { sources: [source] }),
      chunk('b', { sources: [source] }),
      { type: 'finalizeResponseStream', close: true, error: false },
    ],
  });
  assert.equal(events.filter((e) => e.type === 'citation').length, 1);
});

test('several chunks of one page cite that page once', async () => {
  // Retrieval returns chunks; a visitor wants pages. Three hits inside the
  // headphones page is one place to go and read, not three.
  const events = await collect({
    frames: [
      {
        type: 'finalizeResponseStream',
        close: true,
        error: false,
        sources: [
          {
            id: 'chunk-a',
            title: 'en-us-headphones.txt',
            description: 'Headphones product line',
            docSource: '/headphones',
            text: 'MOQ from 500 units',
          },
          {
            id: 'chunk-b',
            title: 'en-us-headphones.txt',
            description: 'Headphones product line',
            docSource: '/headphones',
            text: 'Other detail',
          },
          {
            id: 'chunk-c',
            title: 'en-us-overstock.txt',
            description: 'Overstock',
            docSource: '/overstock',
            text: 'Clearance',
          },
        ],
      },
    ],
  });
  const cites = events.filter((e) => e.type === 'citation') as { citation: EngineCitation }[];
  assert.equal(cites.length, 2, 'chunks of one page were cited separately');
  assert.deepEqual(
    cites.map((c) => c.citation.url),
    ['/headphones', '/overstock'],
  );
});

test('a citation is titled for a reader, not by its storage filename', async () => {
  const events = await collect({
    frames: [
      {
        type: 'finalizeResponseStream',
        close: true,
        error: false,
        sources: [
          {
            id: 'c1',
            title: 'en-us-headphones.txt',
            description: 'Headphones product line',
            docSource: '/headphones',
            text: 'x',
          },
        ],
      },
    ],
  });
  const cite = events.find((e) => e.type === 'citation') as { citation: EngineCitation };
  assert.equal(cite.citation.title, 'Headphones product line');
});

test('the hosted fork keeps the document name as provenance and never exposes a file URL', async () => {
  const events = await collect({
    frames: [
      chunk('Grounded answer.', {
        sources: [
          {
            id: 'vendor-internal-id',
            title: 'supplychainsai-positioning.md',
            description: 'Unknown',
            docSource: 'a text file uploaded by the user.',
            url: 'file:///opt/vibekb/collector/hotdir/supplychainsai-positioning.md',
          },
        ],
      }),
      { type: 'finalizeResponseStream', close: true, error: false },
    ],
  });
  const cite = events.find((event) => event.type === 'citation');
  assert.ok(cite?.type === 'citation');
  assert.equal(cite.citation.sourceId, 'supplychainsai-positioning.md');
  assert.equal(cite.citation.title, 'supplychainsai-positioning.md');
  assert.equal(cite.citation.url, undefined);
});

test('an answer that is only reasoning is a failure, not a blank reply', async () => {
  // ADR-002 §7: at a low token budget these models spend the whole allowance on
  // reasoning and return nothing visible. Reporting success would show the
  // visitor an empty bubble and record the run as fine.
  const events = await collect({
    frames: [
      chunk('<think>thinking forever and never answering</think>'),
      { type: 'finalizeResponseStream', close: true, error: false },
    ],
  });
  const last = events.at(-1) as { type: string; category?: string };
  assert.equal(last.type, 'error');
  assert.equal(last.category, 'content_filtered');
});

test('a vendor error frame is normalized, not passed through raw', async () => {
  const events = await collect({
    frames: [{ type: 'abort', textResponse: null, error: 'Workspace not found', close: true }],
  });
  const last = events.at(-1) as { type: string; category?: string; safeDetail?: string };
  assert.equal(last.type, 'error');
  assert.ok(last.category);
  assert.ok(!JSON.stringify(last).includes('127.0.0.1'), 'error leaked a hostname');
});

test('a vendor 500 becomes a transient error', async () => {
  const events = await collect({ status: 500 });
  const last = events.at(-1) as { type: string; category?: string; retriable?: boolean };
  assert.equal(last.type, 'error');
  assert.equal(last.category, 'transient');
  assert.equal(last.retriable, true);
});

test('a vendor 429 becomes quota', async () => {
  const events = await collect({ status: 429 });
  assert.equal((events.at(-1) as { category?: string }).category, 'quota');
});

test('exceeding the stream duration limit yields a timeout error', async () => {
  const events = await collect(
    { frames: [chunk('a'), chunk('b'), chunk('c')], delayMs: 200 },
    { ...REQUEST, limits: { ...REQUEST.limits, maxStreamDurationMs: 120 } },
  );
  const last = events.at(-1) as { type: string; category?: string };
  assert.equal(last.type, 'error');
  assert.equal(last.category, 'timeout');
});

test('a malformed frame fails the run instead of being silently dropped', async () => {
  // Changed deliberately. Skipping a frame we cannot parse loses output we
  // cannot account for, and the visitor gets an answer with a hole in it that
  // reads as complete — for a sales assistant, a sentence missing its
  // qualifier is worse than no sentence.
  const events = await collect({
    raw: 'data: {"type":"textResponseChunk","textResponse":"MOQ is ","sources":[]}\n\ndata: {not json\n\ndata: {"type":"finalizeResponseStream","close":true}\n\n',
  });
  const last = events.at(-1) as { type: string; category?: string };
  assert.equal(last.type, 'error');
  assert.equal(last.category, 'transient');
  assert.ok(
    !events.some((event) => event.type === 'final'),
    'a run with an unparseable frame still reported a final answer',
  );
});

test('a stream that ends before the engine finishes is a failure, not an answer', async () => {
  // Truncation used to produce a `final` built from whatever had arrived, so a
  // dropped connection mid-sentence was recorded as a complete answer.
  const events = await collect({
    raw: 'data: {"type":"textResponseChunk","textResponse":"Our MOQ is 5","sources":[]}\n\n',
  });
  const last = events.at(-1) as { type: string; category?: string; retriable?: boolean };
  assert.equal(last.type, 'error');
  assert.equal(last.category, 'transient');
  assert.equal(last.retriable, true);
  assert.ok(!events.some((event) => event.type === 'final'), 'a truncated stream produced a final');
});

test('a complete stream still produces exactly one terminal event', async () => {
  const events = await collect({
    frames: [
      chunk('Our MOQ is 500.', { close: true }),
      { type: 'finalizeResponseStream', close: true, error: false },
    ],
  });
  const terminals = events.filter((event) => event.type === 'final' || event.type === 'error');
  assert.equal(terminals.length, 1, `expected one terminal event, got ${terminals.length}`);
  assert.equal(terminals[0]?.type, 'final');
});

test('an answer that runs past its output budget is stopped and reported', async () => {
  // The budget was declared and never enforced, so a runaway answer billed
  // until the vendor felt like stopping.
  const events = await collect(
    { frames: [...Array.from({ length: 200 }, (_, i) => chunk(`overlong sentence ${i}. `))] },
    { ...REQUEST, limits: { ...REQUEST.limits, maxDeliveredOutputUnits: 20 } },
  );
  const last = events.at(-1) as { type: string; category?: string; retriable?: boolean };
  assert.equal(last.type, 'error');
  assert.equal(last.category, 'invalid_request');
  assert.equal(
    last.retriable,
    false,
    'a budget overrun must not invite a retry that overruns again',
  );
  assert.ok(
    events.filter((event) => event.type === 'token').length < 200,
    'the stream ran to completion despite the budget',
  );
});

test('the output budget counts hidden reasoning, not just visible text', async () => {
  // These models bill their private reasoning inside the same completion
  // budget, so counting only what a visitor sees lets a run spend far past its
  // limit while appearing to produce almost nothing.
  const hidden = `<think>${'deliberating at length. '.repeat(40)}</think>`;
  const events = await collect(
    {
      frames: [
        chunk(hidden),
        chunk('Short answer.'),
        { type: 'finalizeResponseStream', close: true },
      ],
    },
    { ...REQUEST, limits: { ...REQUEST.limits, maxDeliveredOutputUnits: 30 } },
  );
  const last = events.at(-1) as { type: string; category?: string };
  assert.equal(last.type, 'error', 'reasoning tokens were not counted against the budget');
  assert.equal(last.category, 'invalid_request');
});

test('a caller abort is reported as neither timeout nor failure', async () => {
  // The two were told apart by matching an error message, so a caller abort
  // near the deadline could be mislabelled. They are now distinct identities.
  const { server, baseUrl } = await vendor({
    frames: [chunk('a'), chunk('b'), chunk('c')],
    delayMs: 50,
  });
  const engine = new AnythingLlmEngine({
    baseUrl,
    apiKey: 'test-key',
    workspaceSlug: 'ws',
    engineVersion: '1.0.0-test',
  });
  const controller = new AbortController();
  const events: EngineEvent[] = [];
  try {
    const handle = await engine.createRun(REQUEST, controller.signal);
    for await (const event of engine.streamRun(handle, controller.signal)) {
      events.push(event);
      controller.abort();
    }
  } finally {
    server.close();
  }
  assert.ok(
    !events.some((event) => event.type === 'error' && event.category === 'timeout'),
    'a caller abort was reported as a deadline expiry',
  );
});

test('cancelling a finished run says so, rather than denying it existed', async () => {
  const { server, baseUrl } = await vendor({
    frames: [chunk('done'), { type: 'finalizeResponseStream', close: true }],
  });
  const engine = new AnythingLlmEngine({
    baseUrl,
    apiKey: 'k',
    workspaceSlug: 'ws',
    engineVersion: '1.0.0-test',
  });
  try {
    const handle = await engine.createRun(REQUEST, new AbortController().signal);
    for await (const _ of engine.streamRun(handle, new AbortController().signal)) {
      // drain
    }
    assert.equal(await engine.cancelRun(handle), 'already_finished');
    assert.equal(
      await engine.cancelRun({ operationId: 'never-existed', engineRunId: 'x' }),
      'unknown_run',
      'a run we never saw must not be reported as already finished',
    );
  } finally {
    server.close();
  }
});

test('the final frame is not lost when the stream ends without a blank line', async () => {
  // Observed against the real vendor: it closes the response right after the
  // last frame, with no trailing blank line — and that last frame is the ONLY
  // one carrying sources. A reader that requires the separator drops every
  // citation while the answer still looks perfectly fine.
  const events = await collect({
    raw:
      'data: {"type":"textResponseChunk","textResponse":"MOQ is 500.","sources":[]}\n\n' +
      'data: {"type":"finalizeResponseStream","close":true,"error":false,"sources":[{"id":"doc-1","title":"headphones","docSource":"/headphones","text":"MOQ from 500 units"}]}',
  });
  assert.equal(events.filter((e) => e.type === 'citation').length, 1, 'citations were dropped');
  const final = events.at(-1) as { type: string; citations: unknown[] };
  assert.equal(final.type, 'final');
  assert.equal(final.citations.length, 1);
});

test('citations still arrive when close:true lands before the citation frame', async () => {
  // The real vendor's frame order: the LAST text chunk carries close:true, and
  // the sources arrive in a separate finalizeResponseStream frame after it.
  // Stopping at the first close flag loses every citation while the answer
  // itself still looks correct — which is exactly how this shipped unnoticed.
  const events = await collect({
    frames: [
      chunk('MOQ is 500.', { close: true }),
      {
        type: 'finalizeResponseStream',
        close: true,
        error: false,
        sources: [
          {
            id: 'doc-1',
            title: 'headphones',
            docSource: '/headphones',
            text: 'MOQ from 500 units',
          },
        ],
      },
    ],
  });
  assert.equal(events.filter((e) => e.type === 'citation').length, 1, 'citations were dropped');
  const final = events.at(-1) as { type: string; citations: unknown[] };
  assert.equal(final.type, 'final');
  assert.equal(final.citations.length, 1);
});

test('health reports a safe status with no host or credential', async () => {
  const { server, baseUrl } = await vendor({});
  const engine = new AnythingLlmEngine({
    baseUrl,
    apiKey: 'test-key',
    workspaceSlug: 'ws',
    engineVersion: '1.0.0-test',
  });
  try {
    const health = await engine.health();
    assert.equal(health.status, 'live');
    const body = JSON.stringify(health);
    assert.ok(!body.includes('127.0.0.1'));
    assert.ok(!body.includes('test-key'));
  } finally {
    server.close();
  }
});

test('the knowledge attestation identifies the credential without revealing it', async () => {
  const testCredential = ['super', 'secret', 'key'].join('-');
  const engine = new AnythingLlmEngine({
    baseUrl: 'http://unused',
    allowInsecureRemoteHttp: true,
    apiKey: testCredential,
    workspaceSlug: 'ws',
    engineVersion: '1.0.0-test',
  });
  const attestation = await engine.attestKnowledgeCredential();
  assert.equal(attestation.spaceId, 'ws');
  assert.ok(attestation.credentialId.length > 0);
  assert.ok(
    !attestation.credentialId.includes(testCredential),
    'the attestation embedded the raw credential',
  );
});

test('rotating the credential changes the attested identity', async () => {
  const make = (apiKey: string) =>
    new AnythingLlmEngine({
      baseUrl: 'http://unused',
      allowInsecureRemoteHttp: true,
      apiKey,
      workspaceSlug: 'ws',
      engineVersion: '1.0.0-test',
    });
  const before = await make('key-one').attestKnowledgeCredential();
  const after = await make('key-two').attestKnowledgeCredential();
  assert.notEqual(before.credentialId, after.credentialId, 'a silent key swap would be invisible');
});

test('an engine with no agent surface reports one that is off', async () => {
  const server = createServer((req, res) => {
    if (req.url?.includes('/workspace/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ workspace: [{ agentProvider: null, agentModel: null }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  const engine = new AnythingLlmEngine({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k',
    workspaceSlug: 'ws',
    engineVersion: 'test',
  });
  try {
    const surface = await engine.inspectToolSurface();
    assert.equal(surface.known, true);
    assert.equal(surface.enabled, false);
  } finally {
    server.close();
  }
});

test('an enabled agent surface is reported, and names which one', async () => {
  // The run contract sets maxToolCalls to zero. This protocol never reports a
  // tool call mid-stream, so the only place that limit can be enforced is here.
  const server = createServer((req, res) => {
    if (req.url?.includes('/workspace/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ workspace: [{ agentProvider: 'openai', agentModel: 'gpt-4' }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  const engine = new AnythingLlmEngine({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k',
    workspaceSlug: 'ws',
    engineVersion: 'test',
  });
  try {
    const surface = await engine.inspectToolSurface();
    assert.equal(surface.enabled, true);
    assert.match(surface.detail, /agentProvider/);
    assert.doesNotMatch(surface.detail, /openai|gpt-4/, 'tool setting values leaked into detail');
  } finally {
    server.close();
  }
});

test('fork-specific nested tool fields make the inspected schema unknown', async () => {
  const engine = new AnythingLlmEngine({
    baseUrl: 'https://kb.example.test',
    apiKey: 'k',
    workspaceSlug: 'ws',
    engineVersion: 'test',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          workspace: {
            agentProvider: null,
            agentModel: null,
            threads: [
              {
                enabledTools: ['web-search'],
                agentSkills: [{ name: 'private-search', enabled: true }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
  });
  const surface = await engine.inspectToolSurface();
  assert.equal(surface.known, false);
  assert.equal(surface.enabled, false);
  assert.match(surface.detail, /threads\[0\]\.enabledTools/);
  assert.match(surface.detail, /threads\[0\]\.agentSkills/);
  assert.doesNotMatch(surface.detail, /web-search|private-search/);
});

test('capabilities nested under a reviewed container still fail closed', async () => {
  const engine = new AnythingLlmEngine({
    baseUrl: 'https://kb.example.test',
    apiKey: 'k',
    workspaceSlug: 'ws',
    engineVersion: 'test',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          workspace: {
            agentProvider: null,
            agentModel: null,
            threads: [{ slug: 'thread-1', user_id: null, capabilities: { webSearch: true } }],
          },
        }),
        { status: 200 },
      ),
  });
  const surface = await engine.inspectToolSurface();
  assert.equal(surface.known, false);
  assert.equal(surface.enabled, false);
  assert.match(surface.detail, /threads\[0\]\.capabilities/);
});

test('an unreviewed workspace field is unknown even when its name avoids tool keywords', async () => {
  const engine = new AnythingLlmEngine({
    baseUrl: 'https://kb.example.test',
    apiKey: 'k',
    workspaceSlug: 'ws',
    engineVersion: 'test',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          workspace: {
            agentProvider: null,
            agentModel: null,
            capabilities: { webSearch: true },
          },
        }),
        { status: 200 },
      ),
  });
  const surface = await engine.inspectToolSurface();
  assert.equal(surface.known, false);
  assert.equal(surface.enabled, false);
  assert.match(surface.detail, /unreviewed workspace fields: capabilities/);
});

test('an object-shaped workspace with an agent surface is also refused', async () => {
  const server = createServer((req, res) => {
    if (req.url?.includes('/workspace/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ workspace: { agentProvider: 'openai', agentModel: 'gpt-4' } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  const engine = new AnythingLlmEngine({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k',
    workspaceSlug: 'ws',
    engineVersion: 'test',
  });
  try {
    const surface = await engine.inspectToolSurface();
    assert.equal(surface.known, true);
    assert.equal(surface.enabled, true);
  } finally {
    server.close();
  }
});

test('a missing workspace shape is unknown, never assumed tool-free', async () => {
  const engine = new AnythingLlmEngine({
    baseUrl: 'https://kb.example.test',
    apiKey: 'k',
    workspaceSlug: 'ws',
    engineVersion: 'test',
    fetchImpl: async () => new Response(JSON.stringify({ workspace: null }), { status: 200 }),
  });
  const surface = await engine.inspectToolSurface();
  assert.equal(surface.known, false);
  assert.equal(surface.enabled, false);
});

test('an unreachable engine is unknown, never assumed safe', async () => {
  // "Could not check" and "checked and it is off" must not be the same answer.
  const engine = new AnythingLlmEngine({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'k',
    workspaceSlug: 'ws',
    engineVersion: 'test',
  });
  const surface = await engine.inspectToolSurface();
  assert.equal(surface.known, false);
  assert.equal(surface.enabled, false, 'unknown must not be reported as enabled either');
});

test('every non-alphabetic script is charged densely, including Thai and Devanagari', () => {
  // The regression this replaces: a numeric cutoff gave Thai (U+0E00) and
  // Devanagari (U+0900) the cheap Latin rate — 20 units for 80 code points,
  // the same shape as the original CJK defect — while the comment above it
  // claimed both were covered.
  const DENSE: [string, string][] = [
    ['Thai', 'ก'],
    ['Devanagari', 'क'],
    ['CJK', '产'],
    ['Hangul', '한'],
    ['Kana', 'あ'],
    ['Arabic', 'ب'],
    ['Hebrew', 'ש'],
    ['Emoji', '🙂'],
  ];
  for (const [name, character] of DENSE) {
    const estimate = estimateOutputUnits(character.repeat(80));
    assert.ok(estimate >= 80, `${name}: 80 code points estimated at ${estimate} units`);
  }
});

test('scripts that genuinely tokenize several characters per unit stay cheap', () => {
  // Charging these densely would make the budget useless for European
  // languages, so the allowlist has to be a real classification, not "Latin".
  for (const [name, character] of [
    ['Latin', 'a'],
    ['Greek', 'α'],
    ['Cyrillic', 'д'],
  ] as [string, string][]) {
    const estimate = estimateOutputUnits(character.repeat(80));
    assert.ok(estimate <= 25, `${name}: estimated at ${estimate} units, expected the cheap rate`);
  }
});

test('an unclassified script is charged densely rather than cheaply', () => {
  // The allowlist inverts the old default on purpose: a script nobody has
  // classified under-serves the customer instead of over-spending the budget.
  assert.ok(estimateOutputUnits('\u{10400}'.repeat(40)) >= 40, 'Deseret was charged cheaply');
  assert.ok(estimateOutputUnits('\u1200'.repeat(40)) >= 40, 'Ethiopic was charged cheaply');
});

test('combining marks and mixed scripts are counted, not skipped', () => {
  assert.ok(estimateOutputUnits('e\u0301'.repeat(40)) >= 20);
  const mixed = 'MOQ 产品 500 单位 🙂 ';
  assert.ok(
    estimateOutputUnits(mixed.repeat(10)) > estimateOutputUnits('a'.repeat(mixed.length * 10)),
  );
  assert.equal(estimateOutputUnits(''), 0);
});

test('a CJK answer cannot run four times past its budget', async () => {
  const events = await collect(
    { frames: Array.from({ length: 40 }, () => chunk('产'.repeat(10))) },
    { ...REQUEST, limits: { ...REQUEST.limits, maxDeliveredOutputUnits: 20 } },
  );
  const last = events.at(-1) as { type: string; category?: string };
  assert.equal(last.type, 'error', 'a CJK answer ran past its budget unchecked');
  assert.equal(last.category, 'invalid_request');
  const emitted = events.filter((event) => event.type === 'token').length;
  assert.ok(emitted <= 4, `emitted ${emitted} chunks against a 20-token budget`);
});

test('a mixed-script answer is bounded too', async () => {
  const events = await collect(
    { frames: Array.from({ length: 40 }, () => chunk('MOQ 产品 500 单位 🙂 ')) },
    { ...REQUEST, limits: { ...REQUEST.limits, maxDeliveredOutputUnits: 25 } },
  );
  assert.equal((events.at(-1) as { type: string }).type, 'error');
});
