import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaStorage } from '@vibelingan-channel/media-storage';

test('function startup wires CloudBase media storage for raw Alibaba payloads', async () => {
  process.env.TCB_ENV = 'startup-wiring-test';
  process.env.JWT_SECRET = 'startup-wiring-test-secret';

  await import('./index.ts');

  assert.doesNotThrow(
    () => mediaStorage(),
    'the function must configure media storage before the first raw payload write',
  );
});
