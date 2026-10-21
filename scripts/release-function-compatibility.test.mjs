import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCompatibility } from './release/function-compatibility.mjs';

import { compatibilityFixture as setup } from './release-function-fixtures.mjs';
const hash = (c) => c.repeat(64);

test('allows old code only with evidence for every current data format, client and retained configuration', () => {
  const x = setup();
  const result = evaluateCompatibility(x);
  assert.equal(result.status, 'allowed');
  assert.deepEqual(result.configuration, { mode: 'retain-current', revision: 'config-r2' });
  assert.deepEqual(result.databaseWrites, []);
});

test('evidence for the old data revision cannot approve a later data change', () => {
  const x = setup();
  x.observation.data.revision = 'data-r3';
  assert.equal(evaluateCompatibility(x).status, 'manual-required');
});

for (const [name, change, reason] of [
  [
    'new DB constraint',
    (x) => {
      x.observation.data.constraintsSha256 = hash('d');
    },
    'COMPATIBILITY_CONTEXT_CHANGED',
  ],
  [
    'new browser contract',
    (x) => {
      x.observation.exposedClientContracts.push('catalog-ui-v3');
    },
    'EXPOSED_CLIENT_INCOMPATIBLE',
  ],
  [
    'historical record format absent from old reader',
    (x) => {
      x.report.readerFormats = ['catalog-v2'];
    },
    'UNSUPPORTED_READ_FORMAT',
  ],
  [
    'old writer cannot handle current format',
    (x) => {
      x.report.writerFormats = ['catalog-v1'];
    },
    'UNSUPPORTED_WRITE_FORMAT',
  ],
  [
    'old writer replaces document and loses new fields',
    (x) => {
      x.report.preservesUnknownFields = false;
    },
    'OLD_WRITER_MAY_DROP_FIELDS',
  ],
  [
    'Updating function with available billing',
    (x) => {
      x.observation.functions[0].status = 'Updating';
    },
    'FUNCTION_NOT_ACTIVE',
  ],
  [
    'billing unavailable',
    (x) => {
      x.observation.functions[0].availableStatus = 'Unavailable';
    },
    'FUNCTION_NOT_ACTIVE',
  ],
  [
    'runtime drift',
    (x) => {
      x.observation.functions[0].runtime = 'Nodejs22.14';
    },
    'CURRENT_CONFIGURATION_NOT_COMPATIBLE',
  ],
  [
    'handler drift',
    (x) => {
      x.observation.functions[0].handler = 'server.main';
    },
    'CURRENT_CONFIGURATION_NOT_COMPATIBLE',
  ],
  [
    'role drift',
    (x) => {
      x.observation.functions[0].role = 'another-role';
    },
    'CURRENT_CONFIGURATION_NOT_COMPATIBLE',
  ],
  [
    'layer change',
    (x) => {
      x.observation.functions[0].layers = [{ name: 'network', version: 2 }];
    },
    'CURRENT_CONFIGURATION_NOT_COMPATIBLE',
  ],
  [
    'missing required secret reference',
    (x) => {
      x.observation.functions[0].configuration.references = [];
    },
    'MISSING_CONFIGURATION_REFERENCE',
  ],
  [
    'secret version rotated since proof',
    (x) => {
      x.observation.functions[0].configuration.references[0].version = 'key-v3';
    },
    'COMPATIBILITY_CONTEXT_CHANGED',
  ],
  [
    'configuration changed since proof',
    (x) => {
      x.observation.functions[0].configuration.revision = 'config-r3';
    },
    'COMPATIBILITY_CONTEXT_CHANGED',
  ],
  [
    'failed compatibility test',
    (x) => {
      x.report.checks[0].status = 'failed';
    },
    'COMPATIBILITY_CHECK_FAILED',
  ],
  [
    'missing compatibility test',
    (x) => {
      x.report.checks.pop();
    },
    'MISSING_COMPATIBILITY_CHECK',
  ],
  [
    'duplicate compatibility test',
    (x) => {
      x.report.checks[0] = x.report.checks[1];
    },
    'MISSING_COMPATIBILITY_CHECK',
  ],
  [
    'missing report',
    (x) => {
      x.report = null;
    },
    'MISSING_COMPATIBILITY_REPORT',
  ],
  [
    'foreign baseline package',
    (x) => {
      x.baseline.sha256 = hash('e');
    },
    'COMPATIBILITY_CONTEXT_CHANGED',
  ],
])
  test(`refuses ${name}`, () => {
    const x = setup();
    change(x);
    const r = evaluateCompatibility(x);
    assert.equal(r.status, 'manual-required');
    assert(r.reasons.includes(reason), JSON.stringify(r));
  });

for (const [name, change] of [
  [
    'stale observation',
    (x) => {
      x.now += 300001;
    },
  ],
  [
    'future observation',
    (x) => {
      x.observation.observedAt++;
    },
  ],
  [
    'foreign environment',
    (x) => {
      x.observation.target.envId = 'other-env';
    },
  ],
  [
    'missing live function',
    (x) => {
      x.observation.functions = [];
    },
  ],
  [
    'duplicate live function',
    (x) => {
      x.observation.functions.push(x.observation.functions[0]);
    },
  ],
  [
    'raw environment secrets',
    (x) => {
      x.observation.functions[0].configuration.env = { JWT_SECRET: 'do-not-expose' };
    },
  ],
  [
    'duplicate data format',
    (x) => {
      x.observation.data.formats.push('catalog-v1');
    },
  ],
  [
    'unknown runtime shape',
    (x) => {
      x.baseline.handler = undefined;
    },
  ],
  [
    'invalid layer version',
    (x) => {
      x.baseline.layers = [{ name: 'layer', version: 0 }];
    },
  ],
  [
    'invalid function name',
    (x) => {
      x.baseline.name = null;
      x.observation.functions[0].name = null;
      x.report.name = null;
    },
  ],
  [
    'invalid package path',
    (x) => {
      x.baseline.packagePath = '../other.zip';
    },
  ],
])
  test(`malformed ${name} stops instead of producing an approved plan`, () => {
    const x = setup();
    change(x);
    assert.throws(() => evaluateCompatibility(x));
  });

test('set order and observation refresh do not invalidate evidence for unchanged versions', () => {
  const x = setup();
  x.observation.data.formats.reverse();
  x.observation.exposedClientContracts.reverse();
  x.now += 60000;
  x.observation.observedAt = x.now;
  assert.equal(evaluateCompatibility(x).status, 'allowed');
});

test('returned decision cannot be mutated into an approval', () => {
  const x = setup();
  x.report = null;
  const result = evaluateCompatibility(x);
  assert.throws(() => {
    result.status = 'allowed';
  });
  assert.throws(() => result.reasons.pop());
});
