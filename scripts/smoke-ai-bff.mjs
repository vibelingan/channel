const baseUrl = (process.argv[2] ?? process.env.AI_BFF_URL ?? 'http://localhost:58080').replace(
  /\/$/,
  '',
);
// Liveness and readiness are SEPARATE probes and assert different things.
// Liveness must not touch the database — a database blip restarting a healthy
// container makes the outage longer, not shorter — so the database contract is
// asserted against readiness, which is the probe that is allowed to fail.
const response = await fetch(`${baseUrl}/api/ai/healthz`, {
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`AI BFF health returned HTTP ${response.status}`);
const payload = await response.json();
if (payload?.status !== 'live' || payload?.service !== 'channel-ai-bff') {
  throw new Error('AI BFF liveness contract mismatch');
}
if (payload?.database !== undefined) {
  throw new Error('AI BFF liveness must not report a database; that belongs on readiness');
}

const readyResponse = await fetch(`${baseUrl}/api/ai/readyz`, {
  signal: AbortSignal.timeout(10_000),
});
if (!readyResponse.ok) throw new Error(`AI BFF readiness returned HTTP ${readyResponse.status}`);
const readyPayload = await readyResponse.json();
if (
  readyPayload?.status !== 'ready' ||
  readyPayload?.service !== 'channel-ai-bff' ||
  readyPayload?.database?.isolation !== 'read committed'
) {
  throw new Error('AI BFF readiness contract mismatch');
}

const conversationResponse = await fetch(`${baseUrl}/api/ai/conversations`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ locale: 'en' }),
  signal: AbortSignal.timeout(10_000),
});
if (!conversationResponse.ok) {
  throw new Error(`AI BFF conversation returned HTTP ${conversationResponse.status}`);
}
const conversation = await conversationResponse.json();
if (!conversation?.conversationId || !conversation?.credential) {
  throw new Error('AI BFF conversation contract mismatch');
}

const messageResponse = await fetch(
  `${baseUrl}/api/ai/conversations/${conversation.conversationId}/messages`,
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${conversation.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: process.env.AI_SMOKE_QUESTION ?? 'What is your MOQ?',
      idempotencyKey: crypto.randomUUID(),
    }),
    signal: AbortSignal.timeout(10_000),
  },
);
if (messageResponse.status !== 202) {
  throw new Error(`AI BFF message returned HTTP ${messageResponse.status}`);
}

const streamController = new AbortController();
const streamTimer = setTimeout(() => streamController.abort(), 20_000);
try {
  const streamResponse = await fetch(
    `${baseUrl}/api/ai/conversations/${conversation.conversationId}/events`,
    {
      headers: {
        authorization: `Bearer ${conversation.credential}`,
        'last-event-id': '0',
      },
      signal: streamController.signal,
    },
  );
  if (!streamResponse.ok || !streamResponse.body) {
    throw new Error(`AI BFF stream returned HTTP ${streamResponse.status}`);
  }
  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalSeen = false;
  while (!finalSeen) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .find((line) => line.startsWith('data: '))
        ?.slice(6);
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.type === 'error' || event.type === 'run.failed') {
        throw new Error(`AI BFF smoke run failed: ${event.category ?? 'unknown'}`);
      }
      if (event.type === 'final') finalSeen = true;
    }
  }
  await reader.cancel();
  if (!finalSeen) throw new Error('AI BFF stream ended without final event');
} finally {
  clearTimeout(streamTimer);
}

console.log('AI BFF round-trip smoke: PASS');
