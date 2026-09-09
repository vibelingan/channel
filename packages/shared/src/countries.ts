import names from 'i18n-iso-countries/langs/en.json';
import { z } from 'zod';

// Import only the maintained English dataset, not the package's all-locale
// Node entry point. Labels are presentation; codes are the persisted contract.
const englishNames: Readonly<Record<string, string | string[]>> = names.countries;
export const countryCodes: readonly string[] = Object.freeze(Object.keys(englishNames));
const codes = new Set(countryCodes);
export const CountryCodeSchema = z.string().refine((value) => codes.has(value), 'country');
export function countryName(code: string, locale = 'en'): string {
  if (!codes.has(code)) return '';
  const fallback = englishNames[code];
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return (Array.isArray(fallback) ? fallback[0] : fallback) ?? code;
  }
}
export function countryOptions(locale = 'en') {
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale);
  } catch {
    collator = new Intl.Collator('en');
  }
  return countryCodes
    .map((value) => ({ value, label: countryName(value, locale) }))
    .sort((a, b) => collator.compare(a.label, b.label));
}
