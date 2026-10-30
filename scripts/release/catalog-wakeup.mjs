import { randomUUID } from 'node:crypto';
const repository = 'vibelingan/channel';
const workflow = 'seo-static-canary.yml';
const origin = 'https://supplychainsai.com';

/** Queue checks are cheap; only a pending change can acquire a notification lease. */
export async function wakeCatalog({ store, github, now = Date.now(), nonce = randomUUID() }) {
  if (!Number.isSafeInteger(now) || !/^[a-f0-9-]{36}$/.test(nonce))
    throw Error('Invalid wakeup clock or identity');
  const pending = await store.hasPending(origin);
  if (!pending) return { status: 'idle' };
  const active = await store.activeRenderer();
  if (
    !active ||
    !/^[a-f0-9]{40}$/.test(active.executorSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(active.codeSha ?? '')
  )
    return { status: 'not-configured' };
  const branch = active.executorRef ?? 'feat/seo-foundation';
  if (!['feat/seo-foundation', 'test'].includes(branch)) throw Error('Unapproved executor ref');
  const head = await github.head(branch);
  if (head !== active.executorSha && !(await github.passedCI(head, branch)))
    return { status: 'waiting-ci' };
  const runs = await github.runs(workflow);
  if (
    !Array.isArray(runs) ||
    runs.some(
      (r) => r.repository?.full_name !== repository || r.head_repository?.full_name !== repository,
    )
  )
    throw Error('Incomplete or foreign workflow inventory');
  if (
    runs.some(
      (r) =>
        r.head_branch === branch &&
        ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(r.status),
    )
  )
    return { status: 'busy' };
  const claim = await store.claim({ now, nonce, holdMs: 180000 });
  if (!claim) return { status: 'held' };
  const reason = `catalog-wakeup-${nonce}`;
  try {
    await github.dispatch(workflow, {
      ref: branch,
      inputs: {
        mode: 'site-delivery',
        action: 'publish',
        variant: 'A',
        product_source: 'refresh',
        renderer_sha: active.codeSha,
        expected_activation_id: 'none',
        reason,
      },
    });
  } catch {
    // A lost response may still have started a run. Never immediately send it again.
    await store.finish(nonce, { state: 'unknown', reason, checkedAt: now });
    return { status: 'unknown' };
  }
  await store.finish(nonce, { state: 'sent', reason, checkedAt: now });
  return { status: 'sent', reason };
}
