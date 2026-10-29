import { useEffect, useState } from 'react';

export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export interface LocalDayClock {
  now(): Date;
  later(callback: () => void, delay: number): number;
  cancel(timer: number): void;
  onWake(callback: () => void): () => void;
}

/** Reschedule after midnight and after sleep/timezone changes; dispose all subscriptions. */
export function watchLocalDay(update: (day: string) => void, clock: LocalDayClock): () => void {
  let timer: number | undefined;
  let stopped = false;
  const refresh = () => {
    if (stopped) return;
    if (timer !== undefined) clock.cancel(timer);
    const now = clock.now();
    update(localDay(now));
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    timer = clock.later(refresh, Math.max(1, next.getTime() - now.getTime() + 100));
  };
  const unlisten = clock.onWake(refresh);
  refresh();
  return () => {
    stopped = true;
    if (timer !== undefined) clock.cancel(timer);
    unlisten();
  };
}

/** Undefined on the server and first browser render keeps hydration HTML stable. */
export function useLocalDay(): string | undefined {
  const [day, setDay] = useState<string>();
  useEffect(
    () =>
      watchLocalDay(setDay, {
        now: () => new Date(),
        later: (fn, delay) => window.setTimeout(fn, delay),
        cancel: (id) => window.clearTimeout(id),
        onWake: (fn) => {
          window.addEventListener('focus', fn);
          document.addEventListener('visibilitychange', fn);
          return () => {
            window.removeEventListener('focus', fn);
            document.removeEventListener('visibilitychange', fn);
          };
        },
      }),
    [],
  );
  return day;
}
