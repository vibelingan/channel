import { BlogExposureConflict } from './indexing-convergence.mjs';

/** Remove the staging noindex flag only after the actual domain is ready. */
export async function exposeBlogServer({
  client,
  readHealth,
  readDeployment,
  save,
  verify,
  verifyRestored,
  now = Date.now,
  pause = () => new Promise((done) => setTimeout(done, 2000)),
  timeoutMs = 300000,
}) {
  const before = await readHealth();
  if (!/^[a-f0-9]{40}$/.test(before.releaseId) || typeof before.previewOnly !== 'boolean')
    throw Error('Verified Blog version and staging state required');
  const priorDeployment = await readDeployment();
  if (!priorDeployment.ready)
    throw Error('A Blog deployment is still in progress; no config changed');
  if (!before.previewOnly) {
    await verify();
    return;
  }
  await save({
    phase: 'before',
    action: 'expose',
    service: 'blog-pages',
    releaseId: before.releaseId,
    key: 'BLOG_PREVIEW_ONLY',
    prior: '1',
    desired: '0',
    priorTaskId: priorDeployment.taskId,
  });
  let submittedTaskId;
  try {
    const submitted = await client.call('manageCloudRun', {
      action: 'updateConfig',
      serverName: 'blog-pages',
      envParamsReplaceAll: false,
      serverConfig: { EnvParams: JSON.stringify({ BLOG_PREVIEW_ONLY: '0' }) },
    });
    submittedTaskId = submitted?.data?.taskId == null ? undefined : String(submitted.data.taskId);
  } catch {
    /* The running service resolves a lost acknowledgement; never repeat the write. */
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    let actual;
    try {
      actual = await readHealth();
    } catch {
      /* A rolling instance may briefly be unavailable. */
    }
    if (actual && actual.releaseId !== before.releaseId)
      throw Error('Another Blog program appeared; no further write allowed');
    let deployment;
    try {
      deployment = await readDeployment();
    } catch {
      await pause();
      continue;
    }
    const changedTask = deployment.taskId !== priorDeployment.taskId;
    if (changedTask && submittedTaskId && deployment.taskId !== submittedTaskId)
      throw Error('Another Blog deployment appeared; no further write allowed');
    if (
      actual?.previewOnly === false &&
      changedTask &&
      deployment.kind === 'CONFIG' &&
      deployment.ready
    ) {
      try {
        await verify();
      } catch (error) {
        if (error instanceof BlogExposureConflict) throw error;
        const current = await readHealth();
        const currentDeployment = await readDeployment();
        if (
          current.releaseId !== before.releaseId ||
          current.previewOnly !== false ||
          currentDeployment.taskId !== deployment.taskId ||
          !currentDeployment.ready
        )
          throw Error('Blog verification failed and its state changed; inspect before restoring');
        await save({
          phase: 'restore-before',
          action: 'expose',
          releaseId: before.releaseId,
          prior: '0',
          desired: '1',
          priorTaskId: deployment.taskId,
        });
        let restoreTaskId;
        try {
          const submitted = await client.call('manageCloudRun', {
            action: 'updateConfig',
            serverName: 'blog-pages',
            envParamsReplaceAll: false,
            serverConfig: { EnvParams: JSON.stringify({ BLOG_PREVIEW_ONLY: '1' }) },
          });
          restoreTaskId =
            submitted?.data?.taskId == null ? undefined : String(submitted.data.taskId);
        } catch {
          // One attempt; confirm the outcome from the running service.
        }
        const restoreDeadline = now() + timeoutMs;
        while (now() < restoreDeadline) {
          let restored;
          try {
            restored = await readHealth();
          } catch {
            /* A rolling instance may be unavailable. */
          }
          if (restored && restored.releaseId !== before.releaseId)
            throw Error('Another Blog program appeared during restore; no further write allowed');
          let restoring;
          try {
            restoring = await readDeployment();
          } catch {
            await pause();
            continue;
          }
          const changedRestoreTask = restoring.taskId !== deployment.taskId;
          if (changedRestoreTask && restoreTaskId && restoring.taskId !== restoreTaskId)
            throw Error(
              'Another Blog deployment appeared during restore; no further write allowed',
            );
          if (
            restored?.previewOnly === true &&
            changedRestoreTask &&
            restoring.kind === 'CONFIG' &&
            restoring.ready
          ) {
            await verifyRestored();
            await save({
              phase: 'restored',
              action: 'expose',
              releaseId: restored.releaseId,
              taskId: restoring.taskId,
            });
            throw Error(
              'Blog verification failed; the original indexing restriction was restored',
              { cause: error },
            );
          }
          await pause();
        }
        throw Error('Blog verification failed; indexing restriction restore is unconfirmed');
      }
      await save({
        phase: 'accepted',
        action: 'expose',
        service: 'blog-pages',
        releaseId: actual.releaseId,
        taskId: deployment.taskId,
      });
      return;
    }
    await pause();
  }
  throw Error('Blog staging flag outcome is unconfirmed; inspect the saved recovery input');
}
