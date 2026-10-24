import { evaluateCompatibility, functionRecoveryContext } from './function-compatibility.mjs';
import { freeze, identity, isHash } from './input.mjs';

const kinds = ['reader', 'writer-preserves-unknown', 'api-clients', 'configuration'];

/** Consume test results whose artifact provenance was authenticated by the GitHub source adapter. Never accept a compatible boolean. */
export function produceFunctionCompatibilityReport({
  target,
  baselines,
  observation,
  evidence,
  source,
  suitePolicy,
  now = Date.now(),
}) {
  if (
    source?.verified !== true ||
    source.event !== 'workflow_dispatch' ||
    !isHash(source.manifestSha256) ||
    !/^[a-f0-9]{40}$/.test(source.headSha) ||
    !/^[1-9][0-9]*$/.test(source.artifactId) ||
    evidence?.schemaVersion !== 1 ||
    evidence.purpose !== 'function-compatibility-test-results' ||
    evidence.status !== 'passed' ||
    !Array.isArray(evidence.components) ||
    !Array.isArray(suitePolicy) ||
    !Array.isArray(baselines) ||
    !baselines.length ||
    new Set(evidence.components.map((x) => x.name)).size !== evidence.components.length ||
    new Set(baselines.map((x) => x.name)).size !== baselines.length
  )
    throw new Error('Authenticated compatibility test evidence required');
  const components = baselines.map((baseline) => {
    const context = functionRecoveryContext({ target, baseline, observation, now });
    const result = evidence.components.find((x) => x.name === baseline.name);
    if (
      !result ||
      result.contextSha256 !== context.sha256 ||
      !Array.isArray(result.suites) ||
      result.suites.length !== 4
    )
      throw new Error('Compatibility tests do not cover this production context');
    const checks = kinds.map((kind) => {
      const matches = result.suites.filter((x) => x.kind === kind);
      const suite = matches[0];
      const approved = suitePolicy.filter((x) => x.name === baseline.name && x.kind === kind);
      if (
        matches.length !== 1 ||
        !isHash(suite.suiteSha256) ||
        approved.length !== 1 ||
        approved[0].suiteSha256 !== suite.suiteSha256 ||
        approved[0].testRef !== suite.testRef ||
        !Array.isArray(approved[0].requiredTests) ||
        !approved[0].requiredTests.length ||
        !/^[A-Za-z0-9_./:-]{1,200}$/.test(suite.testRef) ||
        !Array.isArray(suite.tests) ||
        !suite.tests.length ||
        suite.tests.length > 10000 ||
        new Set(suite.tests.map((x) => x.name)).size !== suite.tests.length ||
        suite.tests.some(
          (x) =>
            typeof x.name !== 'string' || !x.name || x.name.length > 512 || x.status !== 'passed',
        )
      )
        throw new Error('Compatibility suite failed, skipped, empty or incomplete');
      if (
        approved[0].requiredTests.some(
          (name) =>
            suite.tests.filter((x) => x.name === name && x.status === 'passed').length !== 1,
        )
      )
        throw new Error('Compatibility evidence lacks required named cases');
      return { kind, status: 'passed', testRef: suite.testRef };
    });
    for (const [kind, field] of [
      ['reader', 'readerFormats'],
      ['writer-preserves-unknown', 'writerFormats'],
      ['api-clients', 'apiContracts'],
    ])
      if (
        identity(suitePolicy.find((x) => x.name === baseline.name && x.kind === kind).covers) !==
        identity(result[field])
      )
        throw new Error('Compatibility coverage differs from reviewed suite');
    const report = {
      name: baseline.name,
      contextSha256: context.sha256,
      readerFormats: result.readerFormats,
      writerFormats: result.writerFormats,
      apiContracts: result.apiContracts,
      preservesUnknownFields: result.preservesUnknownFields,
      checks,
    };
    const decision = evaluateCompatibility({ target, baseline, observation, report, now });
    if (decision.status !== 'allowed')
      throw new Error(`Production compatibility denied: ${decision.reasons.join(',')}`);
    return report;
  });
  return freeze({ schemaVersion: 1, purpose: 'function-recovery-compatibility', components });
}
