import { mergeFunctionEnvironment } from '../release/function-config.mjs';
import { functionConfiguration } from '../release/function-provider.mjs';
import { identity } from '../release/input.mjs';
const key = 'ARTICLE_PUBLISHING_ENABLED';
/** Change one existing admin switch; never emit secret-bearing function details. */
export async function setArticlePublishing({
  manager,
  envId,
  expectedVersion,
  readHealth,
  readPackageHash,
  readEnabled = /** @type {null|(()=>Promise<boolean>)} */ (null),
  beforeChange = async () => {},
  now = Date.now,
  pause = () => new Promise((done) => setTimeout(done, 2000)),
  timeoutMs = 120000,
}) {
  const environment = manager.currentEnvironment();
  await environment.lazyInit();
  if (
    manager.cloudBaseConfig.envId !== envId ||
    environment.getEnvId() !== envId ||
    environment.lazyEnvironmentConfig?.EnvId !== envId
  )
    throw Error('Publishing switch target differs');
  function variables(detail) {
    if (
      detail.FunctionName !== 'admin' ||
      detail.Namespace !== envId ||
      !Array.isArray(detail.Environment?.Variables) ||
      new Set(detail.Environment.Variables.map((x) => x.Key)).size !==
        detail.Environment.Variables.length
    )
      throw Error('Incomplete admin configuration');
    return mergeFunctionEnvironment({
      current: {
        status: 'complete',
        variables: Object.fromEntries(detail.Environment.Variables.map((x) => [x.Key, x.Value])),
      },
      managedKeys: [],
      desired: {},
    });
  }
  function rest(detail) {
    const value = structuredClone(functionConfiguration(detail));
    value.Environment.Variables = value.Environment.Variables.filter((v) => v.Key !== key).sort(
      (a, b) => a.Key.localeCompare(b.Key),
    );
    return identity(value);
  }
  const packageHash = await readPackageHash();
  if (
    typeof expectedVersion !== 'string' ||
    !expectedVersion ||
    !/^[a-f0-9]{64}$/.test(packageHash)
  )
    throw Error('Verified admin code identity required');
  const before = await manager.functions.getFunctionDetail('admin');
  const prior = variables(before);
  if (
    before.Status !== 'Active' ||
    before.AvailableStatus !== 'Available' ||
    before.Runtime !== 'Nodejs20.19' ||
    before.Handler !== 'index.main' ||
    before.Triggers?.length !== 0 ||
    ![undefined, '0', '1'].includes(prior[key]) ||
    (await readHealth()) !== expectedVersion
  )
    throw Error('Verified active admin version required before enabling publication');
  if (prior[key] === '1') {
    if (readEnabled && !(await readEnabled())) return { status: 'unknown' };
    return { status: 'accepted', alreadyEnabled: true };
  }
  const fixed = rest(before);
  const desired = mergeFunctionEnvironment({
    current: { status: 'complete', variables: prior },
    managedKeys: [key],
    desired: { [key]: '1' },
  });
  const logging = {
    ...(typeof before.ClsLogsetId === 'string' ? { clsLogsetId: before.ClsLogsetId } : {}),
    ...(typeof before.ClsTopicId === 'string' ? { clsTopicId: before.ClsTopicId } : {}),
  };
  async function submit(envVariables) {
    try {
      await manager.functions.updateFunctionConfig({ name: 'admin', envVariables, ...logging });
    } catch {
      /* Readback decides a lost acknowledgement. */
    }
  }
  async function observe(value) {
    const end = now() + timeoutMs;
    let detail;
    let stable = 0;
    for (;;) {
      detail = await manager.functions.getFunctionDetail('admin');
      const vars = variables(detail);
      if (rest(detail) !== fixed) return { status: 'unknown' };
      if (detail.Status === 'Active' && detail.AvailableStatus === 'Available') {
        if ((await readPackageHash()) !== packageHash) return { status: 'unknown' };
        if (vars[key] !== value) return { status: 'different', detail };
        let healthy = false;
        try {
          healthy =
            (await readHealth()) === expectedVersion &&
            (!readEnabled || (await readEnabled()) === (value === '1'));
        } catch {}
        stable = healthy ? stable + 1 : 0;
        if (stable === 2) return { status: 'accepted' };
      }
      if (now() >= end) return { status: 'unhealthy', detail };
      await pause();
    }
  }
  await beforeChange();
  await submit(desired);
  let result;
  try {
    result = await observe('1');
  } catch {
    return { status: 'unknown' };
  }
  if (result.status === 'accepted') return result;
  const current = result.detail;
  if (
    !current ||
    rest(current) !== fixed ||
    current.Status !== 'Active' ||
    current.AvailableStatus !== 'Available'
  )
    return { status: 'unknown' };
  if (variables(current)[key] === prior[key])
    return (await readHealth()) === expectedVersion
      ? { status: 'not-written' }
      : { status: 'unknown' };
  if (variables(current)[key] !== '1') return { status: 'unknown' };
  await submit(prior);
  try {
    return (await observe(prior[key])).status === 'accepted'
      ? { status: 'restored' }
      : { status: 'unknown' };
  } catch {
    return { status: 'unknown' };
  }
}
