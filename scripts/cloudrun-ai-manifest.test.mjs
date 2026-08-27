import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { AI_CLOUDRUN_SERVICES } from './cloudrun-ai-manifest.mjs';

test('CloudRun manifest stays in lockstep with deployable packages and Dockerfiles', async () => {
  assert.deepEqual(
    AI_CLOUDRUN_SERVICES.map((service) => service.serviceName),
    ['channel-ai-bff', 'channel-ai-worker'],
  );
  for (const service of AI_CLOUDRUN_SERVICES) {
    await access(service.dockerfile);
    const packagePath = service.dockerfile.replace('/Dockerfile', '/package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    assert.equal(packageJson.name, service.packageName);
    assert.equal(service.memoryGiB, service.cpu * 2);
    assert.ok(service.minInstances >= 1);
    assert.ok(service.requiredEnvironment.includes('DATABASE_URL'));
  }
});
