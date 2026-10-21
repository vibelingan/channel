import { assertHostingPath, assertOrigin, freeze, identity, isHash } from './input.mjs';

const checks = ['reader', 'writer-preserves-unknown', 'api-clients', 'configuration'];
/** Pure policy boundary. Observations and platform metadata must come from trusted read adapters. */
export function functionRecoveryContext({ target, baseline, observation, now = Date.now() }) {
  keys(target, ['envId', 'siteOrigin']);
  token(target.envId);
  assertOrigin(target.siteOrigin);
  keys(baseline, [
    'name',
    'codeSha',
    'packagePath',
    'sha256',
    'runtime',
    'handler',
    'role',
    'layers',
    'requiredConfigKeys',
  ]);
  assertHostingPath(baseline.packagePath);
  if (
    typeof baseline.name !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(baseline.name) ||
    !isHash(baseline.sha256)
  )
    throw new Error('Invalid baseline function');
  const baselineRuntime = runtime(baseline);
  code(baseline.codeSha);
  set(baseline.requiredConfigKeys);
  keys(observation, ['target', 'observedAt', 'data', 'exposedClientContracts', 'functions']);
  if (identity(observation.target) !== identity(target))
    throw new Error('Foreign compatibility observation');
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(observation.observedAt) ||
    observation.observedAt < 0 ||
    observation.observedAt > now ||
    now - observation.observedAt > 300_000
  )
    throw new Error('Stale compatibility observation');
  keys(observation.data, ['revision', 'formats', 'constraintsSha256']);
  if (!isHash(observation.data.constraintsSha256))
    throw new Error('Missing current constraint identity');
  if (
    !Array.isArray(observation.functions) ||
    !observation.functions.length ||
    observation.functions.length > 32 ||
    new Set(observation.functions.map((f) => f.name)).size !== observation.functions.length
  )
    throw new Error('Invalid function inventory');
  const current = observation.functions.find((f) => f.name === baseline.name);
  if (!current) throw new Error('No current function; creation/deletion is outside recovery');
  keys(current, [
    'name',
    'codeSha',
    'status',
    'availableStatus',
    'runtime',
    'handler',
    'role',
    'layers',
    'configuration',
  ]);
  const currentRuntime = runtime(current);
  code(current.codeSha);
  token(current.status);
  token(current.availableStatus);
  keys(current.configuration, ['revision', 'references']);
  token(current.configuration.revision);
  const refs = current.configuration.references;
  if (
    !Array.isArray(refs) ||
    refs.length > 128 ||
    new Set(refs.map((x) => x.name)).size !== refs.length
  )
    throw new Error('Invalid configuration references');
  const configuration = {
    revision: current.configuration.revision,
    references: refs
      .map((ref) => {
        keys(ref, ['name', 'version']);
        return { name: token(ref.name), version: token(ref.version) };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  const body = {
    target: structuredClone(target),
    name: baseline.name,
    baseline: {
      codeSha: baseline.codeSha,
      packageSha256: baseline.sha256,
      ...baselineRuntime,
      requiredConfigKeys: set(baseline.requiredConfigKeys),
    },
    current: {
      codeSha: current.codeSha,
      status: current.status,
      availableStatus: current.availableStatus,
      ...currentRuntime,
      configuration,
    },
    data: {
      revision: token(observation.data.revision),
      formats: set(observation.data.formats),
      constraintsSha256: observation.data.constraintsSha256,
    },
    exposedClientContracts: set(observation.exposedClientContracts),
  };
  return freeze({ body, sha256: identity(body) });
}

/** Bind compatibility test results to the current data, clients and retained configuration. */
export function evaluateCompatibility(input) {
  const context = functionRecoveryContext(input);
  const { body } = context;
  const reasons = [];
  const deny = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (body.current.status !== 'Active' || body.current.availableStatus !== 'Available')
    deny('FUNCTION_NOT_ACTIVE');
  for (const field of ['runtime', 'handler', 'role', 'layers'])
    if (identity(body.baseline[field]) !== identity(body.current[field]))
      deny('CURRENT_CONFIGURATION_NOT_COMPATIBLE');
  if (
    body.baseline.requiredConfigKeys.some(
      (key) => !body.current.configuration.references.some((ref) => ref.name === key),
    )
  )
    deny('MISSING_CONFIGURATION_REFERENCE');
  const report = input.report;
  if (!report) deny('MISSING_COMPATIBILITY_REPORT');
  else {
    keys(report, [
      'name',
      'contextSha256',
      'readerFormats',
      'writerFormats',
      'apiContracts',
      'preservesUnknownFields',
      'checks',
    ]);
    if (report.name !== body.name || report.contextSha256 !== context.sha256)
      deny('COMPATIBILITY_CONTEXT_CHANGED');
    for (const [key, needed, reason] of [
      ['readerFormats', body.data.formats, 'UNSUPPORTED_READ_FORMAT'],
      ['writerFormats', body.data.formats, 'UNSUPPORTED_WRITE_FORMAT'],
      ['apiContracts', body.exposedClientContracts, 'EXPOSED_CLIENT_INCOMPATIBLE'],
    ]) {
      const supported = set(report[key]);
      if (needed.some((value) => !supported.includes(value))) deny(reason);
    }
    if (report.preservesUnknownFields !== true) deny('OLD_WRITER_MAY_DROP_FIELDS');
    if (!Array.isArray(report.checks) || report.checks.length !== checks.length)
      deny('MISSING_COMPATIBILITY_CHECK');
    else
      for (const kind of checks) {
        const matching = report.checks.filter((check) => check.kind === kind);
        if (matching.length !== 1) {
          deny('MISSING_COMPATIBILITY_CHECK');
          continue;
        }
        keys(matching[0], ['kind', 'status', 'testRef']);
        token(matching[0].testRef);
        if (matching[0].status !== 'passed') deny('COMPATIBILITY_CHECK_FAILED');
      }
  }
  return freeze({
    status: reasons.length ? 'manual-required' : 'allowed',
    reasons,
    contextSha256: context.sha256,
    configuration: { mode: 'retain-current', revision: body.current.configuration.revision },
    databaseWrites: [],
  });
}

function keys(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error('Invalid compatibility record');
}
function token(value, empty = false) {
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    (!empty && !value) ||
    !/^[A-Za-z0-9:_.@/-]*$/.test(value)
  )
    throw new Error('Invalid compatibility identifier');
  return value;
}
function set(values) {
  if (!Array.isArray(values) || values.length > 128 || new Set(values).size !== values.length)
    throw new Error('Invalid compatibility set');
  return values.map((value) => token(value)).sort();
}
function layers(values) {
  if (!Array.isArray(values) || values.length > 32) throw new Error('Invalid function layers');
  const result = values
    .map((value) => {
      keys(value, ['name', 'version']);
      token(value.name);
      if (!Number.isSafeInteger(value.version) || value.version < 1)
        throw new Error('Invalid layer version');
      return { name: value.name, version: value.version };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(result.map((value) => value.name)).size !== result.length)
    throw new Error('Duplicate function layer');
  return result;
}
function runtime(value) {
  return {
    runtime: token(value.runtime),
    handler: token(value.handler),
    role: token(value.role, true),
    layers: layers(value.layers),
  };
}
function code(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value))
    throw new Error('Invalid function code identity');
  return value;
}
