import { mergeFunctionEnvironment } from '../release/function-config.mjs';
import { functionConfiguration } from '../release/function-provider.mjs';
import { identity } from '../release/input.mjs';
/** Change one reviewed Blog switch while preserving unrelated settings and secret values. */
export async function setBlogFunctionSwitch({
  name,
  key,
  value,
  manager,
  envId,
  expectedVersion,
  readHealth,
  readPackageHash,
  readAppliedValue = /** @type {null|(()=>Promise<string|undefined>)} */ (null),
  beforeChange = async () => {},
  now = Date.now,
  pause = () => new Promise((done) => setTimeout(done, 2000)),
  timeoutMs = 120000,
}) {
  const booleanSwitch =
    (name === 'admin' && key === 'ARTICLE_PUBLISHING_ENABLED') ||
    (name === 'public-api' && key === 'ARTICLE_PUBLIC_READ_ENABLED');
  const modeSwitch = name === 'admin' && key === 'ARTICLE_DELIVERY_MODE';
  if (!(booleanSwitch && ['0', '1'].includes(value)) && !(modeSwitch && value === 'server'))
    throw Error('Unplanned Blog function switch');
  const runtimeValue = (raw) => raw ?? (modeSwitch ? 'static' : '0');
  const environment = manager.currentEnvironment();
  await environment.lazyInit();
  if (
    manager.getManagerConfig().envId !== envId ||
    environment.getEnvId() !== envId ||
    environment.lazyEnvironmentConfig?.EnvId !== envId
  )
    throw Error('Publishing switch target differs');
  function variables(detail) {
    if (
      detail.FunctionName !== name ||
      detail.Namespace !== envId ||
      !Array.isArray(detail.Environment?.Variables) ||
      new Set(detail.Environment.Variables.map((x) => x.Key)).size !==
        detail.Environment.Variables.length
    )
      throw Error('Incomplete function configuration');
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
    throw Error('Verified function code identity required');
  const before = await manager.functions.getFunctionDetail(name);
  const prior = variables(before);
  if (
    before.Status !== 'Active' ||
    before.AvailableStatus !== 'Available' ||
    before.Runtime !== 'Nodejs20.19' ||
    before.Handler !== 'index.main' ||
    before.Triggers?.length !== 0 ||
    !(modeSwitch ? [undefined, 'static', 'server'] : [undefined, '0', '1']).includes(prior[key]) ||
    (await readHealth()) !== expectedVersion
  )
    throw Error('Verified active function version required before enabling publication');
  if (prior[key] === value) {
    if (readAppliedValue && (await readAppliedValue()) !== runtimeValue(value))
      return { status: 'unknown' };
    return { status: 'accepted', alreadyApplied: true };
  }
  const fixed = rest(before);
  const desired = mergeFunctionEnvironment({
    current: { status: 'complete', variables: prior },
    managedKeys: [key],
    desired: { [key]: value },
  });
  const logging = {
    ...(typeof before.ClsLogsetId === 'string' ? { clsLogsetId: before.ClsLogsetId } : {}),
    ...(typeof before.ClsTopicId === 'string' ? { clsTopicId: before.ClsTopicId } : {}),
  };
  async function submit(envVariables) {
    try {
      await manager.functions.updateFunctionConfig({ name, envVariables, ...logging });
    } catch {
      /* Readback decides a lost acknowledgement. */
    }
  }
  async function observe(value) {
    const end = now() + timeoutMs;
    let detail;
    let stable = 0;
    for (;;) {
      detail = await manager.functions.getFunctionDetail(name);
      const vars = variables(detail);
      if (rest(detail) !== fixed) return { status: 'unknown' };
      if (detail.Status === 'Active' && detail.AvailableStatus === 'Available') {
        if ((await readPackageHash()) !== packageHash) return { status: 'unknown' };
        if (vars[key] !== value) return { status: 'different', detail };
        let healthy = false;
        try {
          healthy =
            (await readHealth()) === expectedVersion &&
            (!readAppliedValue || (await readAppliedValue()) === runtimeValue(value));
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
    result = await observe(value);
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
  if (variables(current)[key] !== value) return { status: 'unknown' };
  await submit(prior);
  try {
    return (await observe(prior[key])).status === 'accepted'
      ? { status: 'restored' }
      : { status: 'unknown' };
  } catch {
    return { status: 'unknown' };
  }
}

/** The existing static publisher keeps its original one-switch interface. */
export async function setArticlePublishing({ readEnabled, ...options }) {
  const result = await setBlogFunctionSwitch({
    ...options,
    name: 'admin',
    key: 'ARTICLE_PUBLISHING_ENABLED',
    value: '1',
    readAppliedValue: readEnabled ? async () => ((await readEnabled()) ? '1' : '0') : null,
  });
  return result.alreadyApplied ? { status: result.status, alreadyEnabled: true } : result;
}
