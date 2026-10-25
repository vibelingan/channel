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
      await verify();
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
