import { setTimeout as pause } from 'node:timers/promises';
import { mergeFunctionEnvironment } from './function-config.mjs';
import { functionConfiguration } from './function-provider.mjs';
import { assertOrigin, identity } from './input.mjs';

/** Only initial catalog activation settings are owned here. All other values remain inside the SDK process. */
export async function setCatalogRuntimeFlags({
  manager,
  target,
  name,
  phase,
  before,
  wait = pause,
}) {
  const writer = ['admin', 'alibaba-catalog-sync'].includes(name);
  if (!((phase === 'record' && writer) || (phase === 'readiness' && name === 'public-api')))
    throw Error('Unreviewed catalog function setting');
  assertOrigin(target.siteOrigin);
  const config = manager.getManagerConfig();
  if (
    config.envId !== target.envId ||
    config.region !== target.region ||
    manager.currentEnvironment().getEnvId() !== target.envId
  )
    throw Error('Catalog setting target differs');
  const prior = readVariables(before, name, target.envId);
  if (name !== 'alibaba-catalog-sync' && prior.CATALOG_DETAIL_APPROVAL_ENABLED !== '1')
    throw Error('Preserve the existing approved-detail business mode');
  const desired = {
    CATALOG_SEO_SITE_ORIGIN: target.siteOrigin,
    CATALOG_DETAIL_APPROVAL_ENABLED: '1',
    ...(writer ? { CATALOG_SEO_RECORDING: '1' } : { CATALOG_SEO_PAGE_READINESS: '1' }),
  };
  const values = mergeFunctionEnvironment({
    current: { status: 'complete', variables: prior },
    managedKeys: Object.keys(desired),
    desired,
  });
  const expected = identity({
    ...functionConfiguration(before),
    Environment: { Variables: values },
  });
  const unchanged = identity(functionConfiguration(before));
  const sameExceptEnvironment = (d) => {
    const { Environment, ...rest } = functionConfiguration(d);
    return identity(rest);
  };
  const outside = sameExceptEnvironment(before);
  let current = await manager.functions.getFunctionDetail(name);
  if (
    identity(functionConfiguration(current)) !== unchanged ||
    current.ModTime !== before.ModTime ||
    current.CodeSize !== before.CodeSize
  )
    throw Error('Catalog function changed before its setting update');
  if (identity(prior) === identity(values))
    return { name, phase, changed: false, websiteWrites: 0 };
  try {
    await manager.functions.updateFunctionConfig({ name, envVariables: values });
  } catch {
    // A lost acknowledgement is settled by configuration readback; this port never repeats the write.
  }
  for (let n = 0; n < 30; n++) {
    try {
      current = await manager.functions.getFunctionDetail(name);
    } catch {
      throw Error('Catalog setting needs readback; no retry submitted');
    }
    if (sameExceptEnvironment(current) !== outside || current.CodeSize !== before.CodeSize)
      throw Error('Another function setting changed; stop before any further write');
    const actual = identity({
      ...functionConfiguration(current),
      Environment: { Variables: readVariables(current, name, target.envId, false) },
    });
    if (
      current.Status === 'Active' &&
      current.AvailableStatus === 'Available' &&
      actual === expected
    )
      return { name, phase, changed: true, websiteWrites: 0 };
    if (['UpdateFailed', 'CreateFailed'].includes(current.Status))
      throw Error('Catalog setting update failed');
    if (actual !== expected && identity(functionConfiguration(current)) !== unchanged)
      throw Error('Catalog settings differ from the exact requested values');
    await wait(2000);
  }
  throw Error('Catalog setting result remains unconfirmed; do not resubmit');
}
function readVariables(detail, name, envId, active = true) {
  if (
    detail?.FunctionName !== name ||
    detail.Namespace !== envId ||
    detail.Type !== 'Event' ||
    detail.Runtime !== 'Nodejs20.19' ||
    detail.Handler !== 'index.main' ||
    (active && (detail.Status !== 'Active' || detail.AvailableStatus !== 'Available')) ||
    !Array.isArray(detail.Environment?.Variables)
  )
    throw Error('Complete managed function configuration required');
  const entries = detail.Environment.Variables;
  if (
    entries.some((v) => typeof v.Key !== 'string' || typeof v.Value !== 'string') ||
    new Set(entries.map((v) => v.Key)).size !== entries.length
  )
    throw Error('Duplicate or incomplete function variables');
  const variables = mergeFunctionEnvironment({
    current: {
      status: 'complete',
      variables: Object.fromEntries(entries.map((v) => [v.Key, v.Value])),
    },
    managedKeys: [],
    desired: {},
  });
  if (variables.TCB_ENV !== envId) throw Error('Function environment differs');
  return variables;
}
