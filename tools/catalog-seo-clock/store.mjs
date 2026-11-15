import { assertDocumentWrite, sdkAnswer } from '../../packages/db/src/cloudbase-sdk-answer.ts';
import { identity } from '../../scripts/release/input.mjs';
import {
  assertScope,
  assertTarget,
  normalizePolicy,
  tables,
} from '../../scripts/release/ledger.mjs';
import { SITE_DELIVERY_POLICY } from '../../scripts/release/site-policy.mjs';

const config = normalizePolicy(SITE_DELIVERY_POLICY);
const site = config.target.siteOrigin;
const wakeId = 'supplychainsai-com';

/** The timer may notify GitHub only for the program registered against the current accepted site. */
export function createCatalogClockStore(db) {
  let selected = null;
  let blocked = null;
  return {
    async hasPending(origin) {
      if (origin !== site) throw Error('Wrong pending queue target');
      for (const collection of ['catalogSeoRequests', 'catalogSeoTasks']) {
        const result = sdkAnswer(
          await db
            .collection(collection)
            .where({ siteOrigin: site, state: 'pending' })
            .limit(1)
            .get(),
        );
        if (!Array.isArray(result.data)) throw Error('Missing pending queue');
        if (result.data.length) return true;
      }
      return false;
    },
    async activeRenderer() {
      const source = await db.runTransaction(readRegistration);
      blocked = source.status === 'ready' ? null : source.status;
      selected = source.status === 'ready' ? source : null;
      return selected?.active ?? null;
    },
    async claim({ now, nonce, holdMs }) {
      const result = await db.runTransaction(async (tx) => {
        // GitHub reads can take time. Recheck the same records before claiming a notification.
        const current = await readRegistration(tx);
        if (current.status !== 'ready') return current;
        if (!selected || current.hash !== selected.hash) return { status: 'registration-changed' };
        const doc = tx.collection('catalogSeoWakeups').doc(wakeId);
        const previous = row(await doc.get(), wakeId);
        if (previous && (!Number.isSafeInteger(previous.until) || previous.until > now))
          return { status: 'held' };
        assertDocumentWrite(
          await doc.set({ owner: nonce, until: now + holdMs, state: 'sending', siteOrigin: site }),
          wakeId,
          'set',
        );
        return { status: 'claimed' };
      });
      blocked = ['claimed', 'held'].includes(result.status) ? null : result.status;
      return result.status === 'claimed';
    },
    async finish(nonce, result) {
      await db.runTransaction(async (tx) => {
        const doc = tx.collection('catalogSeoWakeups').doc(wakeId);
        const current = row(await doc.get(), wakeId);
        if (current?.owner !== nonce) throw Error('Clock notification owner changed');
        const data = Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_id'));
        assertDocumentWrite(
          await doc.set({
            ...data,
            ...result,
            until: result.checkedAt + (result.state === 'unknown' ? 600000 : 180000),
          }),
          wakeId,
          'set',
        );
      });
    },
    outcome(result) {
      return blocked ? { status: blocked } : result;
    },
  };
}

async function readRegistration(tx) {
  const target = row(
    await tx.collection(tables.targets).doc(config.targetId).get(),
    config.targetId,
  );
  const scopeId = `${config.targetId}-site`;
  const scope = row(await tx.collection(tables.scopes).doc(scopeId).get(), scopeId);
  const active = row(await tx.collection('catalogSeoBuilders').doc('active').get(), 'active');
  if (!target || !scope || !active) return { status: 'registration-incomplete' };
  try {
    assertTarget(target, config);
    assertScope(scope, config, 'site');
  } catch {
    return { status: 'registration-incomplete' };
  }
  if (target.dirtyRunId || target.unresolvedOperation) return { status: 'delivery-needs-readback' };
  if (target.lease || target.currentRunId) return { status: 'delivery-busy' };
  if (
    active.catalogTracked !== true ||
    !/^site-[1-9][0-9]*-[1-9][0-9]*$/.test(active.acceptedRunId ?? '') ||
    active.acceptedRunId !== scope.baseline?.sourceRunId ||
    !/^[a-f0-9]{40}$/.test(active.codeSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(active.executorSha ?? '') ||
    !/^[a-f0-9]{64}$/.test(active.manifestSha256 ?? '') ||
    !['feat/seo-foundation', 'test'].includes(active.executorRef)
  )
    return { status: 'registration-incomplete' };
  return { status: 'ready', active, hash: identity({ active, baseline: scope.baseline }) };
}

function row(result, id) {
  const value = sdkAnswer(result);
  if (
    !value ||
    !Object.hasOwn(value, 'data') ||
    (Array.isArray(value.data) && value.data.length > 1)
  )
    throw Error('Missing clock SDK document response');
  const data = Array.isArray(value.data) ? value.data[0] : value.data;
  if (data == null) return null;
  if (typeof data !== 'object' || data._id !== id) throw Error('Wrong clock document identity');
  return data;
}
