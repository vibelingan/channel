import assert from 'node:assert/strict';
import test from 'node:test';

const build = 'b'.repeat(40);
let copy = 0;
// The build stamp is read once per module, so every case loads a fresh copy.
async function healthWith(env: Record<string, string | undefined>) {
  const names = [
    'CHANNEL_BUILD_SHA',
    'CHANNEL_BUILD_TIME',
    'CHANNEL_DEPLOYED_RELEASE',
    'CHANNEL_DEPLOYED_CODE',
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names)
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    const module = await import(`./release.ts?copy=${++copy}`);
    return module.releaseInfo('public-api');
  } finally {
    for (const name of names)
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
  }
}

test('health names the confirming deploy while that deploy confirmed the running build', async () => {
  assert.deepEqual(
    await healthWith({
      CHANNEL_BUILD_SHA: build,
      CHANNEL_BUILD_TIME: '2026-11-05T13:10:00+08:00',
      CHANNEL_DEPLOYED_RELEASE: 'c'.repeat(40),
      CHANNEL_DEPLOYED_CODE: build,
    }),
    {
      status: 'ok',
      service: 'public-api',
      releaseId: build,
      buildTime: '2026-11-05T13:10:00+08:00',
      deployedReleaseId: 'c'.repeat(40),
    },
  );
});

test('code replaced outside the normal deploy no longer claims that deploy', async () => {
  const health = await healthWith({
    CHANNEL_BUILD_SHA: 'a'.repeat(40),
    CHANNEL_DEPLOYED_RELEASE: 'c'.repeat(40),
    CHANNEL_DEPLOYED_CODE: build,
  });
  assert.equal(health.releaseId, 'a'.repeat(40));
  assert.equal('deployedReleaseId' in health, false);
});

test('without deploy configuration health keeps its original shape', async () => {
  assert.deepEqual(await healthWith({}), {
    status: 'ok',
    service: 'public-api',
    releaseId: 'local',
    buildTime: 'local',
  });
});
