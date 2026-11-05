export interface ReleaseInfo {
  status: 'ok';
  service: string;
  releaseId: string;
  buildTime: string;
  /**
   * The normal deploy that confirmed this running build: it uploaded the build, or proved the
   * running one identical to its own apart from the build stamp.
   */
  deployedReleaseId?: string;
}

// The bundler replaces these two with the build's own stamp, so they name the running code.
const releaseId = process.env.CHANNEL_BUILD_SHA || 'local';
const buildTime = process.env.CHANNEL_BUILD_TIME || 'local';

export function releaseInfo(service: string): ReleaseInfo {
  // Read from the function configuration at run time; no build replaces these names. The
  // deploy also records which build it confirmed, so code replaced by any other path stops
  // claiming that deploy.
  const deployedReleaseId = process.env.CHANNEL_DEPLOYED_RELEASE;
  const confirmed = process.env.CHANNEL_DEPLOYED_CODE === releaseId;
  return {
    status: 'ok',
    service,
    releaseId,
    buildTime,
    ...(deployedReleaseId && confirmed ? { deployedReleaseId } : {}),
  };
}
