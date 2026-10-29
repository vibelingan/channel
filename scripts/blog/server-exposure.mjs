/** Remove the staging noindex flag only after the actual domain is ready. */
export async function exposeBlogServer({
  client,
  readHealth,
  save,
  verify,
  now = Date.now,
  pause = () => new Promise((done) => setTimeout(done, 2000)),
  timeoutMs = 120000,
}) {
  const before = await readHealth();
  if (!/^[a-f0-9]{40}$/.test(before.releaseId) || typeof before.previewOnly !== 'boolean')
    throw Error('Verified Blog version and staging state required');
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
  });
  try {
    await client.call('manageCloudRun', {
      action: 'updateConfig',
      serverName: 'blog-pages',
      envParamsReplaceAll: false,
      serverConfig: { EnvParams: JSON.stringify({ BLOG_PREVIEW_ONLY: '0' }) },
    });
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
    if (actual?.previewOnly === false) {
      try {
        await verify();
      } catch (error) {
        const current = await readHealth();
        if (current.releaseId !== before.releaseId || current.previewOnly !== false)
          throw Error('Blog verification failed and its state changed; inspect before restoring');
        await save({
          phase: 'restore-before',
          action: 'expose',
          releaseId: before.releaseId,
          prior: '0',
          desired: '1',
        });
        try {
          await client.call('manageCloudRun', {
            action: 'updateConfig',
            serverName: 'blog-pages',
            envParamsReplaceAll: false,
            serverConfig: { EnvParams: JSON.stringify({ BLOG_PREVIEW_ONLY: '1' }) },
          });
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
          if (restored?.previewOnly === true) {
            await save({ phase: 'restored', action: 'expose', releaseId: restored.releaseId });
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
      });
      return;
    }
    await pause();
  }
  throw Error('Blog staging flag outcome is unconfirmed; inspect the saved recovery input');
}
