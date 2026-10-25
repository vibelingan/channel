/** The MCP SDK forwards only OS defaults unless an explicit child environment is supplied. */
export function blogMcpEnvironment(env) {
  const output = {
    CLOUDBASE_ENV_ID: 'diversity-123-d9grnqfux221323bb',
    TCB_REGION: 'ap-shanghai',
    TCB_SITE: 'domestic',
  };
  for (const key of [
    'TENCENTCLOUD_SECRETID',
    'TENCENTCLOUD_SECRETKEY',
    'TENCENTCLOUD_SESSIONTOKEN',
  ])
    if (typeof env[key] === 'string' && env[key]) output[key] = env[key];
  if (
    env.GITHUB_ACTIONS === 'true' &&
    (!output.TENCENTCLOUD_SECRETID || !output.TENCENTCLOUD_SECRETKEY)
  )
    throw Error('CI requires explicit CloudBase credentials before starting the child process');
  return output;
}
