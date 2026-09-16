const baseUrl = (process.argv[2] ?? process.env.AI_WORKER_URL ?? 'http://localhost:58081').replace(
  /\/$/,
  '',
);
// Same split as the BFF: liveness is dependency-free, readiness proves the
// database AND the engine, and only readiness is allowed to return 503.
const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`AI worker health returned HTTP ${response.status}`);
const payload = await response.json();
if (payload?.status !== 'live') throw new Error('AI worker liveness contract mismatch');
if (payload?.database !== undefined) {
  throw new Error('AI worker liveness must not report a database; that belongs on readiness');
}

const readyResponse = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(10_000) });
if (!readyResponse.ok) throw new Error(`AI worker readiness returned HTTP ${readyResponse.status}`);
const readyPayload = await readyResponse.json();
if (readyPayload?.database?.isolation !== 'read committed') {
  throw new Error('AI worker readiness contract mismatch');
}
console.log('AI worker smoke: PASS');
