import { isAbsolute } from 'node:path';

/** Submit one reviewed Blog program; save the running image before an explicitly requested update. */
export async function submitBlogServer({ client, directory, record, save, operation = 'create' }) {
  const serverName = 'blog-pages';
  const siteOrigin = 'https://supplychainsai.com';
  if (
    !['create', 'update'].includes(operation) ||
    !isAbsolute(directory) ||
    record.envId !== 'diversity-123-d9grnqfux221323bb' ||
    record.serverName !== serverName ||
    record.siteOrigin !== siteOrigin ||
    !/^[a-f0-9]{40}$/.test(record.codeSha)
  )
    throw Error('Unreviewed Blog service target');
  try {
    const inventory = await client.call('queryCloudRun', { action: 'list', pageSize: 100 });
    if (
      !Array.isArray(inventory.data?.services) ||
      !Number.isSafeInteger(inventory.data.pagination?.total) ||
      inventory.data.pagination.total !== inventory.data.services.length ||
      inventory.data.pagination.total > 100
    )
      throw Error('Complete service inventory is required');
    const exists = inventory.data.services.some((service) => service.ServerName === serverName);
    if (operation === 'create' && exists)
      throw Error('Blog service already exists; an explicit backed-up update is required');
    if (operation === 'update') {
      if (!exists) throw Error('The existing Blog service is required for an update');
      const detail = await client.call('queryCloudRun', { action: 'detail', serverName });
      record.before = blogServerRecoveryInput(detail.data);
      record.operation = operation;
      record.status = 'recovery-input-saved';
      await save();
    }
    // One submission. A timeout does not authorize repeating a possibly started deployment.
    record.status = 'submitting';
    await save();
    const started = await client.call('manageCloudRun', {
      action: 'deploy',
      serverName,
      serverType: 'container',
      targetPath: directory,
      waitRegistration: true,
      ...(operation === 'create'
        ? {
            serverConfig: {
              Cpu: 0.25,
              Mem: 0.5,
              MinNum: 0,
              MaxNum: 1,
              Port: 3000,
              Dockerfile: 'Dockerfile',
              BuildDir: '.',
              InitialDelaySeconds: 15,
              OpenAccessTypes: ['PUBLIC'],
              EnvParams: JSON.stringify({
                BLOG_API_ORIGIN: siteOrigin,
                BLOG_PREVIEW_ONLY: '1',
              }),
            },
          }
        : {}),
    });
    if (started.success !== true) throw Error('The cloud submission has no successful receipt');
    record.status = 'submitted';
    record.submission = {
      success: started.success,
      message: started.message,
      buildId: started.data?.buildId,
      runId: started.data?.runId,
    };
    await save();
    console.log(
      'Blog program submitted; no website route or business data changed. Inspect the recorded service before any further write.',
    );
  } catch (error) {
    record.status = record.status === 'submitting' ? 'outcome-unknown' : record.status;
    record.error = error instanceof Error ? error.message : 'Unconfirmed service deployment';
    await save();
    throw error;
  }
}

/** This is an image recovery instruction, never a redacted configuration to write back. */
export function blogServerRecoveryInput(data) {
  const service = data?.service;
  const config = service?.ServerConfig;
  const latest = data?.latestDeploy;
  const online = service?.OnlineVersionInfos;
  if (
    service?.BaseInfo?.ServerName !== 'blog-pages' ||
    service.BaseInfo.Status !== 'normal' ||
    service.BaseInfo.ServerType !== 'container' ||
    config?.EnvId !== 'diversity-123-d9grnqfux221323bb' ||
    config.ServerName !== 'blog-pages' ||
    config.Cpu !== 0.25 ||
    config.Mem !== 0.5 ||
    config.MinNum !== 1 ||
    config.MaxNum !== 1 ||
    config.Port !== 3000 ||
    config.OpenAccessTypes?.join(',') !== 'PUBLIC' ||
    !Array.isArray(online) ||
    online.length !== 1 ||
    String(online[0].FlowRatio) !== '100' ||
    latest?.Status !== 'normal' ||
    latest.IsReleasing !== false ||
    latest.HasTraffic !== true ||
    latest.ImageUrl !== online[0].ImageUrl ||
    !/^ccr\.ccs\.tencentyun\.com\/tcb-100049822712-zswf\/ca-lhdcoaiq_blog-pages:[A-Za-z0-9_.-]+$/.test(
      latest.ImageUrl,
    )
  )
    throw Error('One stable reviewed Blog image and unchanged settings are required');
  return {
    imageUrl: latest.ImageUrl,
    versionName: online[0].VersionName,
    runId: latest.RunId,
    defaultDomain: service.BaseInfo.DefaultDomainName,
    preservedSettings: {
      Cpu: config.Cpu,
      Mem: config.Mem,
      MinNum: config.MinNum,
      MaxNum: config.MaxNum,
      Port: config.Port,
    },
    restore:
      'Deploy this exact image to blog-pages; omit serverConfig so the MCP preserves remote settings. Read health and settings afterwards.',
  };
}
