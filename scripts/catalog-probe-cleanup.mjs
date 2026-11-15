import { setTimeout as pause } from 'node:timers/promises';

/** A lost deletion reply is settled by a complete inventory, never by Exists:false. */
export async function cleanupCatalogProbe({
  manager,
  run,
  owned,
  functionCreated,
  onEvent = async (_event) => {},
  wait = pause,
}) {
  if (
    !/^[1-9][0-9]{7,19}$/.test(run) ||
    new Set(owned).size !== owned.length ||
    owned.some((name) => !name.startsWith(`seo_probe_${run}_`))
  )
    throw Error('Invalid probe cleanup ownership');
  const target = manager.getManagerConfig();
  if (target.envId !== 'diversity-123-d9grnqfux221323bb' || target.region !== 'ap-shanghai')
    throw Error('Wrong probe cleanup target');
  const collections = async () => {
    const names = [];
    let total;
    for (let offset = 0; offset < 10000; offset += 100) {
      const result = await manager.database.listCollections({ MgoLimit: 100, MgoOffset: offset });
      if (
        !Array.isArray(result.Collections) ||
        result.Pager?.Offset !== offset ||
        !Number.isSafeInteger(result.Pager.Total) ||
        result.Pager.Total < 0 ||
        result.Pager.Total > 10000 ||
        (total !== undefined && result.Pager.Total !== total) ||
        result.Collections.length !== Math.min(100, result.Pager.Total - offset) ||
        result.Collections.some((row) => typeof row.CollectionName !== 'string')
      )
        throw Error('Complete cleanup inventory required');
      total = result.Pager.Total;
      names.push(...result.Collections.map((row) => row.CollectionName));
      if (names.length === total) {
        if (new Set(names).size !== names.length) throw Error('Duplicate cleanup inventory');
        return names;
      }
    }
    throw Error('Cleanup inventory exceeds its bounded limit');
  };
  const functions = async () => {
    const names = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const rows = await manager.functions.listFunctions(100, offset);
      if (
        !Array.isArray(rows) ||
        rows.length > 100 ||
        rows.some((row) => typeof row.FunctionName !== 'string')
      )
        throw Error('Complete probe function inventory required');
      names.push(...rows.map((row) => row.FunctionName));
      if (rows.length < 100) {
        if (new Set(names).size !== names.length) throw Error('Duplicate probe function inventory');
        return names;
      }
    }
    throw Error('Probe function inventory exceeds its bounded limit');
  };
  const retryable = new Set([
    'FailedOperation.Timeout',
    'InternalError',
    'ResourceNotFound.Table',
    'ResourceNotFound.Function',
  ]);
  const remove = async (kind, name, read, drop) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await read()).includes(name)) {
        await onEvent({ kind, name, removed: true, alreadyAbsent: true });
        return;
      }
      let failure;
      try {
        await drop();
      } catch (error) {
        failure = error;
      }
      let exists = true;
      let readbacks = 0;
      for (; readbacks < 6; readbacks++) {
        if (readbacks > 0) await wait(250 * 2 ** (readbacks - 1));
        exists = (await read()).includes(name);
        if (!exists || (failure && !retryable.has(failure.code))) break;
      }
      await onEvent({
        kind,
        name,
        attempt: attempt + 1,
        readbacks: Math.min(readbacks + 1, 6),
        removed: !exists,
        errorCode: typeof failure?.code === 'string' ? failure.code : null,
        requestId: typeof failure?.requestId === 'string' ? failure.requestId : null,
      });
      if (!exists) return;
      if (!failure)
        throw Error(`Probe ${kind} deletion acknowledged but not yet confirmed; resource retained`);
      if (!retryable.has(failure.code))
        throw Error(`Probe ${kind} cleanup refused; resource retained`);
      if (attempt < 2) await wait(1000 * (attempt + 1));
    }
    throw Error(`Probe ${kind} cleanup not confirmed; resource retained`);
  };
  if (functionCreated) {
    const name = `seo-catalog-probe-${run}`;
    await remove('function', name, functions, () => manager.functions.deleteFunction(name));
  }
  for (const name of owned)
    await remove('collection', name, collections, () => manager.database.deleteCollection(name));
  if (
    (await collections()).some((name) => owned.includes(name)) ||
    (functionCreated && (await functions()).includes(`seo-catalog-probe-${run}`))
  )
    throw Error('Probe cleanup changed during final readback');
  return { cleaned: true, ownedCollections: owned.length, functionRemoved: functionCreated };
}
