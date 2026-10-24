import { freeze } from './input.mjs';

/** Secret-bearing result stays in the trusted process; never write it to plans, logs or artifacts. */
export function mergeFunctionEnvironment({
  current,
  managedKeys,
  desired,
  removeManagedKeys = [],
}) {
  if (current?.status !== 'complete') throw new Error('A complete environment read is required');
  const prior = variables(current.variables);
  const next = variables(desired);
  const managed = new Set(names(managedKeys));
  const remove = new Set(names(removeManagedKeys));
  if (
    next.some(([key]) => !managed.has(key) || remove.has(key)) ||
    [...remove].some((key) => !managed.has(key))
  )
    throw new Error('Environment change escapes managed keys');
  return freeze(Object.fromEntries([...prior.filter(([key]) => !remove.has(key)), ...next]));
}

const name = (value) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
function names(values) {
  if (
    !Array.isArray(values) ||
    values.length > 128 ||
    values.some((value) => !name(value)) ||
    new Set(values).size !== values.length
  )
    throw new Error('Invalid managed environment keys');
  return values;
}
function variables(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('A complete environment map is required');
  const entries = Object.entries(value);
  if (
    entries.length > 128 ||
    entries.some(([key, value]) => !name(key) || typeof value !== 'string' || value.length > 65536)
  )
    throw new Error('Invalid complete environment map');
  if (entries.some(([, value]) => /\*{3,}|<redacted>|\[redacted\]/i.test(value)))
    throw new Error('A complete, unmasked environment map is required');
  return entries;
}
