import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type LocalDayClock, localDay, watchLocalDay } from './use-local-day.ts';

test('local date follows local timezone, midnight, resumed tabs, and removes its timer/listener', () => {
  let now = new Date(2026, 9, 29, 23, 59, 59);
  let sequence = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>();
  let wake: () => void = () => {};
  let listening = true;
  const clock: LocalDayClock = {
    now: () => new Date(now),
    later: (fn, delay) => {
      const id = ++sequence;
      timers.set(id, { fn, delay });
      return id;
    },
    cancel: (id) => {
      timers.delete(id);
    },
    onWake: (fn) => {
      wake = fn;
      return () => {
        listening = false;
      };
    },
  };
  const observed: string[] = [];
  const stop = watchLocalDay((day) => observed.push(day), clock);
  assert.deepEqual(observed, ['2026-10-29']);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0]?.delay, 1100);
  const tick = [...timers.values()][0]?.fn;
  assert.ok(tick);
  now = new Date(2026, 9, 30, 0, 0, 1);
  tick();
  assert.equal(observed.at(-1), '2026-10-30');
  assert.equal(timers.size, 1);
  now = new Date(2026, 10, 2, 13, 0);
  wake();
  assert.equal(observed.at(-1), '2026-11-02');
  assert.equal(timers.size, 1);
  stop();
  assert.equal(timers.size, 0);
  assert.equal(listening, false);
  const count = observed.length;
  tick();
  wake();
  assert.equal(observed.length, count);
  assert.equal(localDay(new Date(2026, 0, 2)), '2026-01-02');
});
