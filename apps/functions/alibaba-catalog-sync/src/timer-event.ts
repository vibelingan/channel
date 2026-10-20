/** TRIGGER_SRC is set by CloudBase, never read from caller-controlled JSON. */
export function isTrustedSyncTimerEvent(
  event: unknown,
  triggerSource: string | undefined,
): boolean {
  return (
    triggerSource === 'timer' &&
    typeof event === 'object' &&
    event !== null &&
    Reflect.get(event, 'Type') === 'Timer' &&
    Reflect.get(event, 'TriggerName') === 'alibaba-sync-tick'
  );
}
