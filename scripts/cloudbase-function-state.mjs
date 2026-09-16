// SCF Status is the mutation lifecycle; AvailableStatus is BILLING availability.
// https://cloud.tencent.com/document/product/583/115197
// In particular, Updating + Available is not ready for a config update.
export function waitForFunctionActive({
  functionName,
  readState,
  timeoutMs,
  pollIntervalMs,
  sleep,
  now = Date.now,
  log = console.log,
}) {
  const deadline = now() + timeoutMs;
  let nextLogAt = now();
  let lastState;
  const summary = () => {
    const detail = lastState?.detail;
    return detail
      ? JSON.stringify({
          status: detail.Status,
          availableStatus: detail.AvailableStatus,
          runtime: detail.Runtime,
          codeSize: detail.CodeSize,
        })
      : 'no function detail returned';
  };
  while (now() < deadline) {
    lastState = readState(functionName);
    const detail = lastState?.detail;
    if (detail?.Status === 'Active') {
      if (detail.AvailableStatus && detail.AvailableStatus !== 'Available')
        throw new Error(`${functionName}: function billing unavailable; ${summary()}`);
      return detail;
    }
    if (
      ['CreateFailed', 'UpdateFailed', 'PublishFailed', 'DeleteFailed', 'Deleted'].includes(
        detail?.Status,
      )
    )
      throw new Error(`${functionName}: function lifecycle failed; ${summary()}`);
    if (now() >= nextLogAt) {
      log(`${functionName}: waiting for active state; ${summary()}`);
      nextLogAt = now() + 30_000;
    }
    sleep(Math.min(pollIntervalMs, Math.max(deadline - now(), 0)));
  }
  throw new Error(
    `${functionName} did not become active within ${timeoutMs}ms; last state: ${summary()}`,
  );
}
