/** Read only deployment metadata; environment values and credentials are never returned. */
export function blogConfigRelease(value, envId) {
  const data = value?.data;
  const task = data?.task;
  const deploy = data?.latestDeploy;
  if (
    data?.envId !== envId ||
    data?.serverName !== 'blog-pages' ||
    task?.EnvId !== envId ||
    task?.ServerName !== 'blog-pages' ||
    !/^[0-9]+$/.test(String(task?.Id ?? '')) ||
    typeof task?.Status !== 'string' ||
    typeof task?.ChangeType !== 'string'
  )
    throw Error('Exact Blog configuration task metadata required');
  return {
    taskId: String(task.Id),
    kind: task.ChangeType,
    status: task.Status,
    ready:
      task.Status === 'finished' &&
      data.latestDeployStatus === 'normal' &&
      deploy?.Status === 'normal' &&
      deploy.HasTraffic === true &&
      deploy.IsReleasing === false &&
      deploy.FlowRatio === 100 &&
      task.VersionName === `blog-pages-${deploy.DeployId}`,
  };
}
