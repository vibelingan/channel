import { freeze, identity, isHash } from './input.mjs';
import { normalizePolicy, tables } from './ledger.mjs';

const code = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const token = (value) => typeof value === 'string' && /^[A-Za-z0-9:_.@/-]{1,200}$/.test(value);
const tokens = (values) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.length <= 128 &&
  new Set(values).size === values.length &&
  values.every(token);

/** B2 owns this metadata document and must update it in the business writers' transactions. No provision/write port. */
export function createCloudbaseContractReader({ db, policy }) {
  const { targetId } = normalizePolicy(policy);
  if (db?.config?.env !== policy.envId) throw new Error('Contract reader environment mismatch');
  const documentId = `compatibility-${targetId}`;
  return Object.freeze({
    documentId,
    async read() {
      const result = await db.collection(tables.targets).doc(documentId).get();
      if (result?.code || !Array.isArray(result?.data) || result.data.length > 1)
        throw new Error('Contract state read unconfirmed');
      if (result.data.length === 0) return null;
      if (!result.data[0] || typeof result.data[0] !== 'object' || Array.isArray(result.data[0]))
        throw new Error('Invalid contract state document');
      const { _id, ...body } = result.data[0];
      if ((_id !== undefined && _id !== documentId) || JSON.stringify(body).length > 65536)
        throw new Error('Invalid contract state document');
      return body;
    },
  });
}

export function validateContractState(
  record,
  { target, writerInventorySha256, clientInventorySha256 },
  versions,
) {
  const reasons = [];
  if (!record) return ['MISSING_DATA_AND_CLIENT_CONTRACT_STATE'];
  if (!isHash(writerInventorySha256) || !isHash(clientInventorySha256))
    reasons.push('INVENTORY_REVIEW_REQUIRED');
  if (
    record.schemaVersion !== 1 ||
    record.purpose !== 'function-recovery-contract-state' ||
    identity(record.target) !== identity(target) ||
    !token(record.revision) ||
    !token(record.data?.revision) ||
    !tokens(record.data?.formats) ||
    !isHash(record.data?.constraintsSha256) ||
    record.writers?.coverage !== 'all' ||
    record.writers.inventorySha256 !== writerInventorySha256 ||
    !Array.isArray(record.writers?.functions) ||
    record.writers.functions.length > 128 ||
    record.writers.functions.some(
      (x) =>
        !x ||
        !token(x.name) ||
        !Array.isArray(x.codeShas) ||
        !x.codeShas.length ||
        x.codeShas.length > 256 ||
        new Set(x.codeShas).size !== x.codeShas.length ||
        !x.codeShas.every(code),
    ) ||
    new Set(record.writers.functions.map((x) => x.name)).size !== record.writers.functions.length ||
    record.clients?.coverage !== 'all-exposed' ||
    record.clients.inventorySha256 !== clientInventorySha256 ||
    !token(record.clients?.revision) ||
    !tokens(record.clients?.contracts)
  )
    reasons.push('UNPROVEN_DATA_OR_CLIENT_COVERAGE');
  for (const version of versions)
    if (
      !Array.isArray(record.writers?.functions) ||
      record.writers.functions.filter(
        (x) =>
          x?.name === version.name &&
          Array.isArray(x.codeShas) &&
          x.codeShas.includes(version.codeSha),
      ).length !== 1
    )
      reasons.push('WRITER_VERSION_CHANGED');
  return [...new Set(reasons)];
}

/** Package, runtime and health identity are observed live; data/client coverage comes only from B2's reviewed state. */
export function createFunctionObserver({
  policy,
  provider,
  readContractState,
  readHealth,
  clock = Date.now,
}) {
  const target = freeze({ envId: policy.envId, siteOrigin: policy.siteOrigin });
  const names = [...policy.functions];
  if (
    identity(provider.target) !== identity(target) ||
    !names.length ||
    new Set(names).size !== names.length
  )
    throw new Error('Observation target or scope mismatch');
  async function inspect({ signal } = {}) {
    signal?.throwIfAborted();
    const before = await readContractState();
    const functions = [];
    const reasons = [];
    for (const name of names) {
      const snapshot = await provider.read(name, { signal });
      if (snapshot.status !== 'Active' || snapshot.availableStatus !== 'Available') {
        reasons.push('FUNCTION_NOT_ACTIVE');
        functions.push({
          name,
          status: snapshot.status,
          availableStatus: snapshot.availableStatus,
        });
        continue;
      }
      const health = await readHealth(name, { signal });
      const after = await provider.read(name, { signal });
      if (
        !code(health.codeSha) ||
        health.name !== name ||
        health.status !== 'healthy' ||
        identity(health.target) !== identity(target) ||
        snapshot.packageSha256 !== after.packageSha256 ||
        snapshot.versionToken !== after.versionToken ||
        snapshot.configurationToken !== after.configurationToken ||
        after.status !== 'Active' ||
        after.availableStatus !== 'Available'
      )
        throw new Error('Function changed during health observation');
      functions.push({
        name,
        codeSha: health.codeSha,
        packageSha256: after.packageSha256,
        status: after.status,
        availableStatus: after.availableStatus,
        runtime: after.runtime,
        handler: after.handler,
        role: after.role,
        layers: after.layers,
        configuration: {
          revision: after.configurationToken,
          references: after.configurationReferences,
        },
      });
    }
    const current = await readContractState();
    if (identity(before) !== identity(current)) reasons.push('CONTRACT_STATE_CHANGED_DURING_READ');
    reasons.push(...validateContractState(current, { ...policy, target }, functions));
    signal?.throwIfAborted();
    const observedAt = clock();
    const observation = reasons.length
      ? null
      : {
          target,
          observedAt,
          data: {
            revision: current.data.revision,
            formats: [...current.data.formats],
            constraintsSha256: current.data.constraintsSha256,
          },
          exposedClientContracts: [...current.clients.contracts],
          functions,
        };
    return freeze({
      schemaVersion: 1,
      purpose: 'function-live-observation',
      status: reasons.length ? 'manual-required' : 'ready',
      target,
      observedAt,
      reasons: [...new Set(reasons)],
      functions,
      observation,
      contractStateSha256: observation
        ? identity({
            data: observation.data,
            clients: current.clients.revision,
            contracts: observation.exposedClientContracts,
            stateRevision: current.revision,
          })
        : null,
    });
  }
  return Object.freeze({
    inspect,
    async observe(options) {
      const result = await inspect(options);
      if (!result.observation)
        throw Object.assign(
          new Error(`Production observation unavailable: ${result.reasons.join(',')}`),
          { code: 'OBSERVATION_NOT_READY' },
        );
      return result.observation;
    },
  });
}
