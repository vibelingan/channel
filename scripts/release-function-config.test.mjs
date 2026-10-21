import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFunctionEnvironment } from './release/function-config.mjs';

const setup = () => ({
  current: {
    status: 'complete',
    variables: { JWT_SECRET: 'current-secret', HOTFIX_FLAG: 'keep', OLD_FEATURE: 'enabled' },
  },
  managedKeys: ['JWT_SECRET', 'OLD_FEATURE', 'APP_ENV'],
  desired: { APP_ENV: 'test' },
  removeManagedKeys: [],
});
test('preserves console hotfixes and omitted existing keys; removes only explicitly named managed keys', () => {
  const x = setup();
  x.removeManagedKeys = ['OLD_FEATURE'];
  const result = mergeFunctionEnvironment(x);
  assert.deepEqual(result, { JWT_SECRET: 'current-secret', HOTFIX_FLAG: 'keep', APP_ENV: 'test' });
  assert.equal(x.current.variables.OLD_FEATURE, 'enabled');
  assert(Object.isFrozen(result));
});
for (const masked of ['***', 'abc******xyz', '<redacted>', '[REDACTED]'])
  test(`masked value ${masked} never enters a replace-all environment request`, () => {
    const x = setup();
    x.current.variables.JWT_SECRET = masked;
    assert.throws(() => mergeFunctionEnvironment(x), /complete|masked/);
  });
for (const [name, change] of [
  [
    'unknown completeness',
    (x) => {
      x.current.status = 'masked';
    },
  ],
  [
    'missing live map',
    (x) => {
      x.current.variables = undefined;
    },
  ],
  [
    'unmanaged write',
    (x) => {
      x.desired.HOTFIX_FLAG = 'overwrite';
    },
  ],
  [
    'unmanaged deletion',
    (x) => {
      x.removeManagedKeys = ['HOTFIX_FLAG'];
    },
  ],
  [
    'write/delete overlap',
    (x) => {
      x.removeManagedKeys = ['APP_ENV'];
    },
  ],
  [
    'duplicate managed keys',
    (x) => {
      x.managedKeys.push('JWT_SECRET');
    },
  ],
  [
    'non-string SDK value',
    (x) => {
      x.current.variables.HOTFIX_FLAG = 1;
    },
  ],
  [
    'non-plain map',
    (x) => {
      x.desired = [];
    },
  ],
])
  test(`rejects ${name} without a manifest-only fallback`, () => {
    const x = setup();
    change(x);
    assert.throws(() => mergeFunctionEnvironment(x));
  });
test('omitted managed values remain until removal is explicitly requested', () => {
  const x = setup();
  assert.equal(mergeFunctionEnvironment(x).JWT_SECRET, 'current-secret');
  assert.equal(mergeFunctionEnvironment(x).OLD_FEATURE, 'enabled');
});
test('an explicit empty string is a value and no secret is included in validation errors', () => {
  const x = setup();
  x.desired.JWT_SECRET = '';
  assert.equal(mergeFunctionEnvironment(x).JWT_SECRET, '');
  x.desired.HOTFIX_FLAG = 'sensitive-marker';
  assert.throws(
    () => mergeFunctionEnvironment(x),
    (err) => !err.message.includes('current-secret') && !err.message.includes('sensitive-marker'),
  );
});
