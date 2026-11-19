import { subscribe } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const tracePath = process.env.CHANNEL_BLOG_TRACE_PATH;
const requests = new WeakMap();
let sequence = 0;
let remaining = 96;

function record(request, event, status) {
  const row = requests.get(request);
  if (!row || remaining-- <= 0) return;
  try {
    const data = {
      request: row.id,
      phase: row.phase,
      event,
      ms: Math.round(performance.now() - row.start),
      at: Date.now(),
      ...(Number.isInteger(status) ? { status } : {}),
    };
    appendFileSync(tracePath, `${JSON.stringify(data)}\n`);
  } catch {
    // A diagnostic write cannot interrupt or retry the provider request.
  }
}

const phases = new Map([
  ['DescribeCloudBaseBuildService', 'request-upload-address'],
  ['CreateCloudRunServer', 'submit-version'],
  ['UpdateCloudRunServer', 'submit-version'],
  ['DescribeServerManageTask', 'read-registration'],
  ['DescribeCloudRunDeployRecord', 'read-deploy-record'],
]);

if (tracePath) {
  subscribe('http.client.request.created', ({ request }) => {
    const action = phases.get(request.getHeader('x-tc-action'));
    // The pinned staging client sends the source archive as a PUT.
    const phase = action ?? (request.method === 'PUT' ? 'transfer-package' : undefined);
    if (!phase || remaining <= 0) return;
    requests.set(request, { id: ++sequence, phase, start: performance.now() });
    record(request, 'created');
    request.once('finish', () => record(request, 'request-written'));
  });
  subscribe('http.client.request.error', ({ request }) => record(request, 'request-error'));
  subscribe('http.client.response.finish', ({ request, response }) => {
    record(request, 'response', response.statusCode);
  });
}
