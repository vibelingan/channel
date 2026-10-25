import { isAbsolute } from 'node:path';

/** Create only the reviewed service once; every other resource stays outside this port. */
export async function submitBlogServer({ client, directory, record, save }) {
  const serverName = 'blog-pages';
  const siteOrigin = 'https://supplychainsai.com';
  if (
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
    if (inventory.data.services.some((service) => service.ServerName === serverName))
      throw Error(
        'Blog service already exists; inspect its version and preserve recovery input before updating it',
      );
    // One submission. A timeout does not authorize repeating a possibly started deployment.
    record.status = 'submitting';
    await save();
    const started = await client.call('manageCloudRun', {
      action: 'deploy',
      serverName,
      serverType: 'container',
      targetPath: directory,
      waitRegistration: true,
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
      'Blog preview service submitted; no website route or business data changed. Inspect the recorded service before any further write.',
    );
  } catch (error) {
    record.status = record.status === 'submitting' ? 'outcome-unknown' : record.status;
    record.error = error instanceof Error ? error.message : 'Unconfirmed service deployment';
    await save();
    throw error;
  }
}
