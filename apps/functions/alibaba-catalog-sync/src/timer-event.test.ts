import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedSyncTimerEvent } from './timer-event.ts';
const event = { Type: 'Timer', TriggerName: 'alibaba-sync-tick', Time: '2026-10-21T00:00:00Z' };
test('only the platform timer source and configured trigger can dispatch background work', () => {
  assert.equal(isTrustedSyncTimerEvent(event, 'timer'), true);
  for (const source of [undefined, 'wx_client', 'http', 'cloudbase'])
    assert.equal(isTrustedSyncTimerEvent(event, source), false);
  assert.equal(isTrustedSyncTimerEvent({ ...event, TriggerName: 'other' }, 'timer'), false);
  assert.equal(isTrustedSyncTimerEvent({ body: JSON.stringify(event) }, 'timer'), false);
  assert.equal(isTrustedSyncTimerEvent(null, 'timer'), false);
});
