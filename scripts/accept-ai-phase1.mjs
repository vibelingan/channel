/**
 * The one code that proves the publication gate refused.
 *
 * Duplicated as a literal because this script is plain Node and the policy
 * package publishes TypeScript, which Node will not load. The duplication is
 * not left to trust: scripts/accept-ai-phase1.test.mjs fails if this string and
 * the exported constant ever differ, and if the code is not in the engine's
 * closed error taxonomy. A silently renamed code would make the negative
 * assertion unsatisfiable, which reads as a failing test, not a passing one —
 * but only if something is checking.
 */
const PUBLICATION_BLOCKED = 'publication_blocked';

const baseUrl = (process.env.AI_BFF_URL ?? 'http://127.0.0.1:58180').replace(/\/$/, '');
const workerUrl = (process.env.AI_WORKER_URL ?? 'http://127.0.0.1:58181').replace(/\/$/, '');
const approvedPrefix = process.env.AI_PHASE1_APPROVED_PREFIX;
if (!approvedPrefix) throw new Error('AI_PHASE1_APPROVED_PREFIX is required');

async function requireReady(origin, path) {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${origin}${path} returned HTTP ${response.status}`);
}

async function runQuestion(question) {
  const createdResponse = await fetch(`${baseUrl}/api/ai/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locale: 'en' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!createdResponse.ok)
    throw new Error(`conversation create returned ${createdResponse.status}`);
  const created = await createdResponse.json();
  if (!created?.conversationId || !created?.credential) {
    throw new Error('conversation create contract mismatch');
  }

  const sent = await fetch(`${baseUrl}/api/ai/conversations/${created.conversationId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${created.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: question, idempotencyKey: crypto.randomUUID() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (sent.status !== 202) throw new Error(`message append returned ${sent.status}`);

  const response = await fetch(`${baseUrl}/api/ai/conversations/${created.conversationId}/events`, {
    headers: {
      authorization: `Bearer ${created.credential}`,
      'last-event-id': '0',
    },
    signal: AbortSignal.timeout(65_000),
  });
  if (!response.ok || !response.body) throw new Error(`event stream returned ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  try {
    for (;;) {
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
        events.push(event);
        if (['final', 'error', 'run.failed'].includes(event.type)) return events;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error('event stream ended without a terminal event');
}

await requireReady(baseUrl, '/api/ai/healthz');
await requireReady(baseUrl, '/api/ai/readyz');
await requireReady(workerUrl, '/healthz');
await requireReady(workerUrl, '/readyz');

const positive = await runQuestion(
  process.env.AI_PHASE1_POSITIVE_QUESTION ?? 'What does the company do?',
);
const negative = await runQuestion(
  process.env.AI_PHASE1_NEGATIVE_QUESTION ?? 'What does the gateway test document say?',
);
const positiveTypes = positive.map((event) => event.type);
const negativeTypes = negative.map((event) => event.type);
const citations = positive.filter((event) => event.type === 'citation');
const positiveShape =
  positiveTypes[0] === 'token' &&
  positiveTypes.at(-1) === 'final' &&
  positiveTypes.slice(1, -1).every((type) => type === 'citation');
const positiveOk =
  positiveShape &&
  citations.length > 0 &&
  citations.every(
    (event) =>
      typeof event.sourceId === 'string' &&
      event.sourceId.startsWith(approvedPrefix) &&
      !String(event.url ?? '').startsWith('file:'),
  );
// The negative case must be proved by the PUBLICATION GATE, not by "something
// went wrong". Accepting any error meant a provider outage, a quota trip, a
// timeout or a dropped connection all counted as evidence that unapproved
// sources are blocked — a security test that passes loudest exactly when the
// system is least healthy, and passes just as happily with the gate removed.
const negativeErrors = negative.filter((event) => event.type === 'error');
const negativeCategories = negativeErrors.map((event) => event.category);
const negativeOk =
  negativeTypes.length === 1 &&
  negativeTypes[0] === 'error' &&
  negativeCategories.length === 1 &&
  negativeCategories[0] === PUBLICATION_BLOCKED &&
  negative.every((event) => event.type !== 'token' && event.type !== 'citation');

const report = {
  positive: {
    ok: positiveOk,
    eventTypes: positiveTypes,
    citationCount: citations.length,
    approvedOnly: positiveOk,
  },
  negative: {
    ok: negativeOk,
    eventTypes: negativeTypes,
    // Printed so a failure says WHICH code arrived. "expected
    // publication_blocked, got quota" is actionable; "negative.ok false" is not.
    errorCategories: negativeCategories,
    expectedCategory: PUBLICATION_BLOCKED,
    leakedTokens: negative.filter((event) => event.type === 'token').length,
    leakedCitations: negative.filter((event) => event.type === 'citation').length,
  },
};
console.log(JSON.stringify(report));
if (!positiveOk || !negativeOk) process.exitCode = 1;
