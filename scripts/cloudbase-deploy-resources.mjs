export function requestIdFrom(result) {
  return (
    result?.data?.raw?.RequestId ??
    result?.data?.raw?.codeRes?.RequestId ??
    result?.data?.raw?.configRes?.RequestId ??
    result?.data?.requestId ??
    result?.data?.RequestId ??
    result?.requestId ??
    null
  );
}

export function toolMessage(result) {
  if (!result || typeof result !== 'object') return 'no result object returned';
  const raw = result.data?.raw;
  const summary = {
    success: result.success,
    code: result.code ?? raw?.Code,
    message: result.message ?? raw?.Message,
    requestId: requestIdFrom(result),
    dataKeys: result.data && typeof result.data === 'object' ? Object.keys(result.data) : [],
    rawKeys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
  };
  return JSON.stringify(summary).slice(0, 700);
}

export function assertToolSucceeded(result, label) {
  if (!result || typeof result !== 'object') {
    throw new Error(`${label} returned no result object.`);
  }
  if (result.success === false) {
    throw new Error(`${label} failed: ${toolMessage(result)}`);
  }
}

function assertReadbackArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: invalid readback; expected an explicit array (empty [] is valid).`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function ensureGateway(def, { callTool, logger = console }) {
  const current = callTool(
    'cloudbase.queryGateway',
    { action: 'getAccess', targetType: 'function', targetName: def.name },
    { allowFailure: true },
  );
  assertToolSucceeded(current, `${def.name}: getAccess`);
  const apis =
    isRecord(current.data) && Object.hasOwn(current.data, 'apis')
      ? current.data.apis
      : current.data?.raw?.accessList?.APISet;
  assertReadbackArray(apis, `${def.name}: getAccess`);
  for (const api of apis) {
    if (!isRecord(api) || !isNonEmptyString(api.Path)) {
      throw new Error(`${def.name}: getAccess: invalid route entry; expected a non-empty Path.`);
    }
  }
  if (apis.some((api) => api.Path === def.routePath)) {
    logger.log(`${def.name}: gateway route ${def.routePath} already present`);
    return;
  }

  const created = callTool('cloudbase.manageGateway', {
    action: 'createAccess',
    targetType: 'function',
    targetName: def.name,
    path: def.routePath,
    type: 'Event',
    auth: false,
  });
  assertToolSucceeded(created, `${def.name}: createAccess`);
  const requestId = created.data?.requestId ?? created.data?.raw?.RequestId ?? 'unknown';
  logger.log(`${def.name}: created gateway route ${def.routePath}; request ${requestId}`);
}

function normalizeTrigger(trigger, label = 'trigger') {
  if (!isRecord(trigger)) {
    throw new Error(`${label}: invalid trigger entry; expected an object.`);
  }
  const normalized = {};
  for (const [field, sdkField] of [
    ['name', 'TriggerName'],
    ['type', 'Type'],
    ['config', 'TriggerDesc'],
  ]) {
    const value = Object.hasOwn(trigger, sdkField) ? trigger[sdkField] : trigger[field];
    if (!isNonEmptyString(value)) {
      throw new Error(`${label}: invalid trigger entry; expected non-empty ${sdkField}/${field}.`);
    }
    normalized[field] = value;
  }
  return normalized;
}

function readTriggers(def, callTool) {
  const detail = callTool('cloudbase.queryFunctions', {
    action: 'getFunctionDetail',
    functionName: def.name,
  });
  assertToolSucceeded(detail, `${def.name}: getFunctionDetail`);
  const triggers = detail.data?.functionDetail?.Triggers;
  assertReadbackArray(triggers, `${def.name}: getFunctionDetail`);
  return Array.from(triggers, (trigger, index) =>
    normalizeTrigger(trigger, `${def.name}: getFunctionDetail: Triggers[${index}]`),
  );
}

export function reconcileTriggers(def, desired, { callTool, logger = console }) {
  const existing = readTriggers(def, callTool);
  const desiredByName = new Map(desired.map((trigger) => [trigger.name, trigger]));

  for (const trigger of existing) {
    const name = trigger.name;
    const want = desiredByName.get(name);
    if (!want || trigger.type !== want.type || trigger.config !== String(want.config)) {
      logger.log(`  trigger: removing ${def.name}/${name}`);
      const removed = callTool('cloudbase.manageFunctions', {
        action: 'deleteFunctionTrigger',
        functionName: def.name,
        triggerName: name,
      });
      assertToolSucceeded(removed, `${def.name}/${name}: deleteFunctionTrigger`);
    }
  }

  const remaining = new Set(readTriggers(def, callTool).map((trigger) => trigger.name));
  for (const trigger of desired) {
    if (remaining.has(trigger.name)) continue;
    logger.log(`  trigger: creating ${def.name}/${trigger.name} (${trigger.config})`);
    const created = callTool('cloudbase.manageFunctions', {
      action: 'createFunctionTrigger',
      functionName: def.name,
      triggers: [trigger],
    });
    assertToolSucceeded(created, `${def.name}/${trigger.name}: createFunctionTrigger`);
  }

  const byName = (left, right) => left.name.localeCompare(right.name);
  const finalTriggers = readTriggers(def, callTool).sort(byName);
  const wanted = desired.map((trigger) => normalizeTrigger(trigger)).sort(byName);
  if (JSON.stringify(finalTriggers) !== JSON.stringify(wanted)) {
    throw new Error(
      `${def.name}: trigger reconcile failed - wanted ${JSON.stringify(wanted)}, found ${JSON.stringify(finalTriggers)}`,
    );
  }
}
