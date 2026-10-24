import { existsSync } from 'node:fs';
// Offline diagnostic: only the network origin and cloud metadata are local fixtures.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve('@cloudbase/manager-node'));
const { HostingService } = require(join(sdkRoot, 'hosting/index.js'));
const http = require(join(sdkRoot, 'utils/http-request.js'));
const send = http.fetchStream;
const scenario = process.argv[2];
if (
  !['complete', 'reset', 'stream-error', 'error-page', 'prefix-conflict'].includes(scenario) ||
  !process.argv[3]
)
  throw Error(
    'Use complete|reset|stream-error|error-page|prefix-conflict and a new local output path. No cloud access is used.',
  );
if (existsSync(process.argv[3]))
  throw Error('Preserve the existing file and use a new output path.');
const server = createServer((_req, res) => {
  if (scenario === 'reset') {
    res.writeHead(200, { 'content-length': 8 });
    res.write('part');
    setTimeout(() => res.destroy(), 20);
  } else {
    res.writeHead(scenario === 'error-page' ? 503 : 200);
    res.end(scenario === 'error-page' ? 'unavailable' : 'complete');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
http.fetchStream = (url, config) => {
  if (new URL(url).hostname !== 'offline-fixture.invalid') throw Error('Unexpected network origin');
  if (scenario === 'stream-error') {
    const body = new PassThrough();
    setTimeout(() => {
      body.write('part');
      body.destroy(Object.assign(new Error('injected stream failure'), { code: 'ECONNRESET' }));
    }, 20);
    return Promise.resolve({ body, status: 200 });
  }
  return send(`http://127.0.0.1:${server.address().port}/file.txt`, config);
};
const hosting = Object.create(HostingService.prototype);
hosting.environment = {
  inited: true,
  lazyEnvironmentConfig: { EnvId: 'offline-fixture' },
  getAuthConfig: async () => ({}),
};
hosting.checkStatus = async () => ({ CdnDomain: 'offline-fixture.invalid' });
hosting.getHostingBucket = async () => ({ bucket: 'offline-bucket', region: 'offline-region' });
hosting.getCloudKey = () => '';
hosting.environment.getStorageService = () => ({
  walkCloudDirCustom: async () => [{ Key: 'same' }, { Key: 'same/index.html' }],
});
const deadline = setTimeout(() => {
  console.log('SDK_STALLED');
  process.exit(3);
}, 1000);
try {
  if (scenario === 'prefix-conflict')
    await hosting.downloadDirectory({ cloudPath: '', localPath: process.argv[3] });
  else await hosting.downloadFile({ cloudPath: 'file.txt', localPath: process.argv[3] });
  console.log('SDK_COMPLETED');
} catch (error) {
  console.log('SDK_REJECTED', error.code ?? error.name);
  process.exitCode = 2;
} finally {
  clearTimeout(deadline);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
