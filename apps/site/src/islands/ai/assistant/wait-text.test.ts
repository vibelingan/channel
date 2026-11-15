import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitText } from './wait-text.ts';

test('a wait is said in seconds, minutes or hours', () => {
  assert.equal(waitText(1), '1 second');
  assert.equal(waitText(45), '45 seconds');
  assert.equal(waitText(89), '89 seconds');
  assert.equal(waitText(90), '2 minutes');
  assert.equal(waitText(600), '10 minutes');
  assert.equal(waitText(5399), '90 minutes');
  assert.equal(waitText(5400), 'about 2 hours');
  assert.equal(waitText(86_400), 'about 24 hours');
});
