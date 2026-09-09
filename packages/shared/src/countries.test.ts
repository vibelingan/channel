import assert from 'node:assert/strict';
import test from 'node:test';
import { CountryCodeSchema, countryName, countryOptions } from './countries.ts';

test('country display uses labels without changing codes and unknown locale falls back safely', () => {
  assert.equal(countryName('ZZ'), '');
  assert.equal(countryName('DE', 'en'), 'Germany');
  assert.equal(countryName('DE', 'de'), 'Deutschland');
  assert.equal(countryName('DE', 'not_a_locale'), 'Germany');
  assert.ok(countryOptions('not_a_locale').some((o) => o.value === 'HK'));
  for (const item of countryOptions()) assert.ok(CountryCodeSchema.safeParse(item.value).success);
});
