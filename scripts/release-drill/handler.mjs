import { createHash, timingSafeEqual } from 'node:crypto';
import { dummyMain } from './record.mjs';
const collection = 'seoReleaseDrillFixtures';
const purpose = 'channel-recovery-dummy-v1';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
/** Only the temporary function binds this handler to the real SDK. No business collection or caller-selected target. */
export function createDummyDatabaseHandler({ db, envId, runId, version, codeSha, tokenDigest }) {
  if (
    envId !== 'diversity-123-d9grnqfux221323bb' ||
    db?.config?.env !== envId ||
    typeof db.runTransaction !== 'function' ||
    !/^[1-9][0-9]{0,19}$/.test(runId) ||
    !['A', 'B'].includes(version) ||
    !/^[a-f0-9]{40}$/.test(codeSha) ||
    !/^[a-f0-9]{64}$/.test(tokenDigest)
  )
    throw Error('Explicit isolated recovery fixture configuration required');
  const prefix = `seo-drill-${runId}-`;
  return async (event) => {
    if (
      !object(event) ||
      typeof event.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(event.token) ||
      !timingSafeEqual(Buffer.from(digest(event.token), 'hex'), Buffer.from(tokenDigest, 'hex'))
    )
      throw Error('Drill authentication failed');
    const action = event.action;
    const allowed = {
      health: ['action', 'token'],
      read: ['action', 'token', 'id'],
      create: ['action', 'token', 'id', 'requestId', 'label', ...(version === 'B' ? ['note'] : [])],
      update: ['action', 'token', 'id', 'requestId', 'expectedRevision', 'patch'],
      delete: ['action', 'token', 'id', 'requestId', 'expectedRevision'],
    }[action];
    if (!allowed || Object.keys(event).some((key) => !allowed.includes(key)))
      throw Error('Unsupported drill request');
    if (action === 'health') return { purpose, version, codeSha, runId };
    const id = event.id;
    if (
      typeof id !== 'string' ||
      !id.startsWith(prefix) ||
      !/^[a-z0-9-]{1,64}$/.test(id.slice(prefix.length))
    )
      throw Error('Only this drill run may be accessed');
    if (
      action !== 'read' &&
      (typeof event.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(event.requestId))
    )
      throw Error('An idempotent drill request is required');
    if (
      ['update', 'delete'].includes(action) &&
      (!Number.isSafeInteger(event.expectedRevision) || event.expectedRevision < 1)
    )
      throw Error('Expected drill revision required');
    const { token: _token, ...request } = event;
    const requestHash = digest(JSON.stringify(request));
    return db.runTransaction(async (transaction) => {
      const ref = transaction.collection(collection).doc(id);
      const result = await ref.get();
      if (
        !result ||
        result.code ||
        !Object.hasOwn(result, 'data') ||
        (result.data !== null && !object(result.data))
      )
        throw Error('Drill read was not confirmed');
      const current = result.data;
      if (
        current &&
        (current._id !== id ||
          current.purpose !== purpose ||
          !Number.isSafeInteger(current.revision))
      )
        throw Error('Foreign drill record');
      if (action === 'read') {
        if (!current) throw Error('Drill record not found');
        return { record: current, version, codeSha };
      }
      if (current?._drillLastRequest?.id === event.requestId) {
        if (current._drillLastRequest.hash !== requestHash) throw Error('Drill request conflict');
        return { record: current, version, codeSha, replayed: true };
      }
      if (action !== 'create' && current?.revision !== event.expectedRevision)
        throw Error('Drill revision conflict');
      const changed = await dummyMain(
        { ...request, record: current },
        { purpose, version, codeSha },
      );
      const { _id, ...body } = changed.record;
      body._drillLastRequest = { id: event.requestId, hash: requestHash };
      if (Buffer.byteLength(JSON.stringify(body)) > 16384) throw Error('Drill record too large');
      const write = await ref.set(body);
      if (
        write?.code ||
        !write?.requestId ||
        !(write.updated === 1 || write.upserted?.some((item) => item._id === id))
      )
        throw Error('Drill write was not confirmed');
      return { record: { _id, ...body }, version, codeSha, replayed: false };
    });
  };
}
