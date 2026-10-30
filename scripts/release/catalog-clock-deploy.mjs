import { setTimeout as pause } from 'node:timers/promises';
const name = 'catalog-seo-clock';
const owner = 'channel-catalog-seo-clock-v1';
const trigger = { name: 'catalog-seo-minute', type: 'timer', config: '0 * * * * * *' };
const variables = (detail) =>
  Object.fromEntries((detail.Environment?.Variables ?? []).map((v) => [v.Key, v.Value]));

/** This module owns one new private timer function. It never updates existing business functions or gateway routes. */
export async function deployCatalogClock({
  manager,
  action,
  directory,
  codeSha,
  credentials,
  accepted,
  wait = pause,
}) {
  if (!['stage', 'enable', 'disable'].includes(action) || !/^[a-f0-9]{40}$/.test(codeSha))
    throw Error('Explicit clock action and commit required');
  const inventory = await manager.functions.listFunctions(100, 0);
  if (!Array.isArray(inventory) || inventory.length >= 100)
    throw Error('Complete function inventory required');
  let detail = inventory.some((f) => f.FunctionName === name)
    ? await manager.functions.getFunctionDetail(name)
    : null;
  if (
    detail &&
    (detail.Description !== owner ||
      detail.Runtime !== 'Nodejs20.19' ||
      detail.Handler !== 'index.main' ||
      detail.Type !== 'Event')
  )
    throw Error('Clock name is occupied by another owner or runtime');
  const current = detail ? variables(detail) : {};
  const ready = async () => {
    for (let n = 0; n < 30; n++) {
      const result = await manager.functions.getFunctionDetail(name);
      if (result.Status === 'Active' && result.AvailableStatus === 'Available') return result;
      if (['CreateFailed', 'UpdateFailed'].includes(result.Status))
        throw Error('Clock deployment failed; keep it disabled');
      await wait(2000);
    }
    throw Error('Clock deployment still needs readback; do not repeat creation');
  };
  if (action === 'stage') {
    const func = {
      name,
      description: owner,
      runtime: 'Nodejs20.19',
      handler: 'index.main',
      type: 'Event',
      timeout: 90,
      memorySize: 256,
      installDependency: false,
      envVariables: {
        ...current,
        TCB_ENV: 'diversity-123-d9grnqfux221323bb',
        CATALOG_SEO_CLOCK_ENABLED: '0',
      },
    };
    if (!detail)
      await manager.functions.createFunction({ func, functionPath: directory, force: false });
    else {
      await manager.functions.updateFunctionConfig(func);
      await ready();
      await manager.functions.updateFunctionCode({
        func: { name, installDependency: false },
        functionPath: directory,
      });
    }
    detail = await ready();
    const result = await manager.functions.invokeFunction(name, { action: 'health' });
    readClockHealth(result, codeSha, false);
    const source = await manager.functions.getFunctionDownloadUrl(name);
    if (typeof source.CodeSha256 !== 'string' || !source.CodeSha256)
      throw Error('Clock package hash readback missing');
    return {
      action,
      name,
      codeSha,
      packageHash: source.CodeSha256,
      enabled: false,
      websiteWrites: 0,
    };
  }
  if (!detail) throw Error('Stage the reviewed clock program first');
  if (action === 'disable') {
    await manager.functions.updateFunctionConfig({
      name,
      envVariables: { ...current, CATALOG_SEO_CLOCK_ENABLED: '0' },
    });
    const after = await ready();
    if (variables(after).CATALOG_SEO_CLOCK_ENABLED !== '0')
      throw Error('Clock stop is not confirmed');
    return { action, name, enabled: false, websiteWrites: 0 };
  }
  if (
    !accepted?.verified ||
    !/^[a-f0-9]{40}$/.test(accepted.rendererSha ?? '') ||
    !credentials?.privateKey?.includes('PRIVATE KEY') ||
    !/^\d+$/.test(String(credentials.appId)) ||
    !/^\d+$/.test(String(credentials.installationId))
  )
    throw Error('Accepted HTML and repository-only GitHub credentials required before enabling');
  readClockHealth(
    await manager.functions.invokeFunction(name, { action: 'health' }),
    codeSha,
    current.CATALOG_SEO_CLOCK_ENABLED === '1',
  );
  const triggers = detail.Triggers ?? [];
  if (
    triggers.some(
      (t) =>
        t.TriggerName !== trigger.name || t.Type !== 'timer' || t.TriggerDesc !== trigger.config,
    )
  )
    throw Error('Existing timer configuration differs; preserve and inspect');
  if (!triggers.length) await manager.functions.createFunctionTriggers(name, [trigger]);
  await manager.functions.updateFunctionConfig({
    name,
    envVariables: {
      ...current,
      CATALOG_SEO_CLOCK_ENABLED: '1',
      CATALOG_GITHUB_APP_ID: String(credentials.appId),
      CATALOG_GITHUB_INSTALLATION_ID: String(credentials.installationId),
      CATALOG_GITHUB_PRIVATE_KEY: credentials.privateKey,
    },
  });
  const after = await ready();
  const values = variables(after);
  if (
    values.CATALOG_SEO_CLOCK_ENABLED !== '1' ||
    values.CATALOG_GITHUB_PRIVATE_KEY !== credentials.privateKey ||
    (after.Triggers ?? []).length !== 1 ||
    after.Triggers[0].TriggerDesc !== trigger.config
  )
    throw Error('Clock activation needs readback; stop before another change');
  return {
    action,
    name,
    enabled: true,
    rendererSha: accepted.rendererSha,
    timer: trigger.config,
    websiteWrites: 0,
  };
}

export function readClockHealth(response, codeSha, enabled) {
  if (
    !response ||
    typeof response.RequestId !== 'string' ||
    !response.RequestId ||
    typeof response.RetMsg !== 'string' ||
    response.RetMsg.length > 4096 ||
    (response.InvokeFinished !== undefined && response.InvokeFinished !== 1) ||
    (response.RetCode !== undefined && response.RetCode !== 0) ||
    (typeof response.ErrMsg === 'string' && response.ErrMsg.trim())
  )
    throw Error('Clock invocation is not confirmed');
  let health;
  try {
    health = JSON.parse(response.RetMsg);
  } catch {
    throw Error('Clock invocation returned invalid JSON');
  }
  if (health?.service !== name || health.codeSha !== codeSha || health.enabled !== enabled)
    throw Error('Running clock program differs from staged source');
  return health;
}
