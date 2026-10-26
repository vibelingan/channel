/** Fixed execution identity; no caller-supplied function, database or route is accepted. */
export function readDummyInvocation(env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REPOSITORY !== 'vibelingan/channel' ||
    env.GITHUB_REF !== 'refs/heads/feat/seo-foundation' ||
    env.GITHUB_JOB !== 'drill' ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    env.TCB_ENV_ID !== 'diversity-123-d9grnqfux221323bb' ||
    env.CLOUDBASE_REGION !== 'ap-shanghai' ||
    env.SITE_URL !== 'https://supplychainsai.com' ||
    env.DUMMY_RECOVERY_CONFIRM !== 'ISOLATED_RECOVERY_ONLY'
  )
    throw Error('Untrusted isolated recovery invocation');
  return { codeSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID };
}

/** manager-node uses SCF Invoke. Some response versions omit legacy RetCode/InvokeFinished. */
export function createDummyInvoker({ manager, token, onResponse = () => {} }) {
  if (
    !/^[a-f0-9]{64}$/.test(token) ||
    manager.getManagerConfig().envId !== 'diversity-123-d9grnqfux221323bb' ||
    manager.getManagerConfig().region !== 'ap-shanghai'
  )
    throw Error('Explicit dummy credentials required');
  return async (input) => {
    if (!input || Object.hasOwn(input, 'token'))
      throw Error('A drill request cannot override authentication');
    if (!['health', 'read', 'create', 'update', 'delete'].includes(input.action))
      throw Error('Unplanned dummy operation');
    let result;
    try {
      result = await manager.functions.invokeFunction('seo-release-dummy', { ...input, token });
    } catch {
      throw Error('Dummy invocation unconfirmed');
    }
    onResponse({
      action: input.action,
      platformRequestId: typeof result?.RequestId === 'string' ? result.RequestId : null,
      functionRequestId:
        typeof result?.FunctionRequestId === 'string' ? result.FunctionRequestId : null,
      durationMs: Number.isFinite(result?.Duration) ? result.Duration : null,
      authenticationRejected: [result?.ErrMsg, result?.RetMsg].some(
        (value) => typeof value === 'string' && value.includes('Drill authentication failed'),
      ),
    });
    if (result?.ErrMsg?.includes('Explicit isolated recovery fixture configuration required'))
      throw Object.assign(
        Error('Dummy function is missing its explicit environment or run configuration'),
        { code: 'DUMMY_CONFIGURATION_UNCONFIRMED' },
      );
    if (
      !result?.RequestId ||
      typeof result.RetMsg !== 'string' ||
      result.RetMsg.length > 65536 ||
      (Object.hasOwn(result, 'RetCode') && result.RetCode !== 0) ||
      (Object.hasOwn(result, 'InvokeFinished') && result.InvokeFinished !== 1) ||
      (typeof result.ErrMsg === 'string' && result.ErrMsg.trim())
    )
      throw Error('Dummy execution did not confirm success');
    try {
      const value = JSON.parse(result.RetMsg);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
      if (!['A', 'B'].includes(value.version) || !/^[a-f0-9]{40}$/.test(value.codeSha))
        throw Error();
      if (input.action === 'health') {
        if (
          value.purpose !== 'channel-recovery-dummy-v1' ||
          !/^[1-9][0-9]{0,19}$/.test(value.runId)
        )
          throw Error();
      } else if (
        !value.record ||
        value.record._id !== input.id ||
        value.record.purpose !== 'channel-recovery-dummy-v1' ||
        !Number.isSafeInteger(value.record.revision) ||
        value.record.revision < 1 ||
        typeof value.record.deleted !== 'boolean'
      )
        throw Error();
      return value;
    } catch {
      throw Error('Dummy execution returned invalid data');
    }
  };
}

/** Creation and the native bundle check must use the same explicit environment. */
export function dummyFunctionConfiguration(runId, tokenDigest) {
  if (!/^[1-9][0-9]{0,19}$/.test(runId ?? '') || !/^[a-f0-9]{64}$/.test(tokenDigest ?? ''))
    throw Error('Explicit dummy run and credential digest required');
  return {
    name: 'seo-release-dummy',
    type: 'Event',
    runtime: 'Nodejs20.19',
    handler: 'index.main',
    timeout: 15,
    memorySize: 256,
    role: 'TCB_QcsRole',
    installDependency: false,
    triggers: [],
    envVariables: {
      TCB_ENV: 'diversity-123-d9grnqfux221323bb',
      DUMMY_RUN_ID: runId,
      DUMMY_TOKEN_DIGEST: tokenDigest,
    },
  };
}
