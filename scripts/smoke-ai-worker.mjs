const baseUrl = (process.argv[2] ?? process.env.AI_WORKER_URL ?? 'http://localhost:58081').replace(
  /\/$/,
  '',
);
const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`AI worker health returned HTTP ${response.status}`);
const payload = await response.json();
if (payload?.status !== 'live' || payload?.database?.isolation !== 'read committed') {
  throw new Error('AI worker health contract mismatch');
}
console.log('AI worker smoke: PASS');
