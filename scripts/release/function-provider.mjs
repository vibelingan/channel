import { createHmac, randomBytes } from 'node:crypto';
import { fetchFully } from '../smoke-http.mjs';
import { checkFunctionArchive } from './function-archive.mjs';
import { mergeFunctionEnvironment } from './function-config.mjs';
import { assertOrigin, freeze, identity, isHash, sha256 } from './input.mjs';

/** No config, trigger, route, create or delete methods are exposed by this code-only port. */
export function createCloudbaseFunctionProvider({
  manager,
  target,
  region,
  names,
  configurationKey,
  request = fetchFully,
}) {
  const fixed = freeze(structuredClone(target));
  assertOrigin(fixed.siteOrigin);
  if (
    !Array.isArray(names) ||
    !names.length ||
    new Set(names).size !== names.length ||
    names.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(name))
  )
    throw new Error('Explicit function scope required');
  const allowed = new Set(names);
  const environment = manager.currentEnvironment();
  const functions = environment.getFunctionService();
  if (
    configurationKey !== undefined &&
    (!Buffer.isBuffer(configurationKey) || configurationKey.length < 32)
  )
    throw new Error('Configuration identity key must contain at least 32 bytes');
  const key = configurationKey ? Buffer.from(configurationKey) : randomBytes(32);
  const bound = async () => {
    if (
      !fixed.envId ||
      environment.getEnvId() !== fixed.envId ||
      manager.getManagerConfig().envId !== fixed.envId ||
      !region ||
      manager.getManagerConfig().region !== region
    )
      throw new Error('Function provider target mismatch');
    await environment.lazyInit();
    const config = environment.lazyEnvironmentConfig;
    if (
      config?.EnvId !== fixed.envId ||
      config.Functions?.length !== 1 ||
      config.Functions[0].Namespace !== fixed.envId ||
      ![undefined, 'scf'].includes(config.Functions[0].Backend)
    )
      throw new Error('Unproven SCF function namespace');
  };
  const select = (name) => {
    if (!allowed.has(name)) throw new Error('Unplanned function');
  };
  const safe = async (callback, functionName) => {
    let stage = 'bind-target';
    try {
      await bound();
      return await callback((value) => {
        stage = value;
      });
    } catch {
      throw Object.assign(
        new Error(`Function provider ${stage} unconfirmed; inspect the release journal`),
        { code: 'FUNCTION_PROVIDER_UNCONFIRMED', stage, functionName },
      );
    }
  };
  const summarize = (detail, name, recovery) => {
    if (
      detail.FunctionName !== name ||
      detail.Namespace !== fixed.envId ||
      detail.Type !== 'Event' ||
      detail.FunctionVersion !== '$LATEST' ||
      !detail.RequestId ||
      !detail.FunctionId ||
      typeof detail.ModTime !== 'string' ||
      !Number.isSafeInteger(detail.CodeSize) ||
      typeof detail.Runtime !== 'string' ||
      detail.Handler !== 'index.main' ||
      typeof detail.Role !== 'string' ||
      !Array.isArray(detail.Layers) ||
      !Array.isArray(detail.Environment?.Variables) ||
      detail.CodeSecret
    )
      throw new Error('Unproven event function detail');
    if (!Array.isArray(detail.Triggers)) throw new Error('Unproven function trigger inventory');
    const recoveryReasons = [];
    if (detail.Triggers.length) recoveryReasons.push('EXISTING_TRIGGER_OUTSIDE_RECOVERY_SCOPE');
    if (
      detail.VpcConfig?.VpcId ||
      detail.VpcConfig?.SubnetId ||
      detail.VpcConfig?.vpc ||
      detail.VpcConfig?.subnet
    )
      recoveryReasons.push('VPC_OUTSIDE_RECOVERY_SCOPE');
    if (recovery && recoveryReasons.length)
      throw new Error('Function configuration outside initial recovery scope');
    const variables = detail.Environment.Variables;
    if (new Set(variables.map((x) => x.Key)).size !== variables.length)
      throw new Error('Duplicate function environment key');
    mergeFunctionEnvironment({
      current: {
        status: 'complete',
        variables: Object.fromEntries(variables.map((x) => [x.Key, x.Value])),
      },
      managedKeys: [],
      desired: {},
    });
    const { Status, AvailableStatus, ModTime, CodeSize, InstallDependency, RequestId } = detail;
    const configuration = functionConfiguration(detail);
    const configurationToken = createHmac('sha256', key)
      .update(identity(configuration))
      .digest('hex');
    return {
      name,
      functionId: detail.FunctionId,
      runtime: detail.Runtime,
      handler: detail.Handler,
      role: detail.Role,
      layers: detail.Layers.map((x) => ({ name: x.LayerName, version: x.LayerVersion })),
      status: Status,
      availableStatus: AvailableStatus,
      configurationToken,
      configurationReferences: variables
        .map(({ Key, Value }) => ({
          name: Key,
          version: createHmac('sha256', key)
            .update(identity({ envId: fixed.envId, name, key: Key, value: Value }))
            .digest('hex'),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      versionToken: identity({ ModTime, CodeSize, FunctionId: detail.FunctionId }),
      installDependency: InstallDependency,
      requestId: RequestId,
      codeBytes: CodeSize,
      triggerCount: detail.Triggers.length,
      recoveryEligibility: {
        status: recoveryReasons.length ? 'manual-required' : 'within-scope',
        reasons: recoveryReasons,
      },
    };
  };
  const readSnapshot = async (name, recovery, { signal, includeBytes = false } = {}) => {
    select(name);
    signal?.throwIfAborted();
    return safe(async (stage) => {
      stage('read-configuration');
      const first = summarize(await functions.getFunctionDetail(name), name, recovery);
      signal?.throwIfAborted();
      if (first.status !== 'Active' || first.availableStatus !== 'Available')
        return freeze({ ...first, packageSha256: null });
      stage('download-source');
      const source = await functions.getFunctionDownloadUrl(name);
      signal?.throwIfAborted();
      const url = new URL(source.Url);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        !url.hostname.endsWith('.myqcloud.com') ||
        !source.RequestId
      )
        throw new Error('Invalid function download source');
      stage('download-package');
      const response = await request('GET', url.href, {
        signal,
        timeoutMs: 15_000,
        maxBytes: 16 * 1024 * 1024,
        redirect: 'error',
      });
      signal?.throwIfAborted();
      if (response.status !== 200) throw new Error('Function download failed');
      stage('configuration-readback');
      const after = summarize(await functions.getFunctionDetail(name), name, recovery);
      signal?.throwIfAborted();
      stage('configuration-comparison');
      if (
        after.status !== 'Active' ||
        after.availableStatus !== 'Available' ||
        first.configurationToken !== after.configurationToken ||
        first.versionToken !== after.versionToken
      )
        throw new Error('Function changed during readback');
      const snapshot = freeze({
        ...after,
        packageSha256: sha256(response.body),
        packageBytes: response.body.length,
      });
      return includeBytes ? { snapshot, bytes: Buffer.from(response.body) } : snapshot;
    }, name);
  };
  const read = (name, options) => readSnapshot(name, true, options);
  return Object.freeze({
    target: fixed,
    region,
    read,
    inspect: (name, options) => readSnapshot(name, false, options),
    capture: (name, options) => readSnapshot(name, false, { ...options, includeBytes: true }),
    async updateCode(input, { signal } = {}) {
      const { name, runtime, handler, expectedSnapshot } = structuredClone(input);
      select(name);
      const bytes = Buffer.from(input.bytes);
      const hash = sha256(bytes);
      if (
        !isHash(input.sha256) ||
        hash !== input.sha256 ||
        handler !== 'index.main' ||
        !/^Nodejs\d+\.\d+$/.test(runtime)
      )
        throw new Error('Invalid archived function update');
      checkFunctionArchive(bytes);
      signal?.throwIfAborted();
      const current = await read(name, { signal });
      if (
        current.status !== 'Active' ||
        current.availableStatus !== 'Available' ||
        current.runtime !== runtime ||
        current.handler !== handler ||
        expectedSnapshot?.name !== name ||
        current.packageSha256 !== expectedSnapshot.packageSha256 ||
        current.configurationToken !== expectedSnapshot.configurationToken ||
        current.versionToken !== expectedSnapshot.versionToken
      )
        throw new Error('Function changed before update');
      signal?.throwIfAborted();
      return safe(async (stage) => {
        stage('submit-code');
        signal?.throwIfAborted();
        const result = await functions.updateFunctionCode({
          func: { name, runtime, handler, installDependency: false, isWaitInstall: false },
          base64Code: bytes.toString('base64'),
        });
        if (!result?.RequestId) throw new Error('Function update has no receipt');
        return { submitted: true, providerOperationId: result.RequestId };
      }, name);
    },
  });
}

/** Secret-bearing configuration stays inside the trusted process. Never log or archive it. */
export function functionConfiguration(detail) {
  const {
    RequestId,
    Status,
    AvailableStatus,
    StatusDesc,
    StatusReasons,
    CodeInfo,
    CodeResult,
    CodeError,
    ErrNo,
    CodeSize,
    CodeSha256,
    ModTime,
    InstallDependency,
    ...configuration
  } = detail;
  return configuration;
}
