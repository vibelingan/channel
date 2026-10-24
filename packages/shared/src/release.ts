export interface ReleaseInfo {
  status: 'ok';
  service: string;
  releaseId: string;
  buildTime: string;
}

const releaseId = process.env.CHANNEL_BUILD_SHA || 'local';
const buildTime = process.env.CHANNEL_BUILD_TIME || 'local';

export function releaseInfo(service: string): ReleaseInfo {
  return {
    status: 'ok',
    service,
    releaseId,
    buildTime,
  };
}
