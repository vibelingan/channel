export function nextCounterValue(current: unknown, delta: number): number {
  if (current === undefined || current === null) return delta;
  if (typeof current === 'number' && Number.isFinite(current)) return current + delta;
  throw new Error(
    `@vibelingan-channel/db: cannot increment a non-numeric counter value (got ${typeof current}).`,
  );
}
