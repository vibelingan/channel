export function parseCatalogQuantity(
  input: unknown,
): { status: 'invalid' | 'empty' } | { status: 'valid'; value: number } {
  if (input === '') return { status: 'empty' };
  if (typeof input !== 'string' || input.length > 16 || !/^[1-9][0-9]*$/.test(input))
    return { status: 'invalid' };
  const value = Number(input);
  return Number.isSafeInteger(value) ? { status: 'valid', value } : { status: 'invalid' };
}
