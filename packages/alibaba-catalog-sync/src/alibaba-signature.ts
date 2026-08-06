/**
 * GOP-style request signing for the Alibaba.com Open Platform.
 *
 * Canonicalization (per the platform's documented signature algorithm —
 * live-gateway confirmation is the MIU 15 gate, ARCHITECTURE §8.2):
 *   1. take every request parameter EXCEPT `sign` itself;
 *   2. sort keys by ASCII code ascending;
 *   3. concatenate `key + value` pairs with no separators;
 *   4. prepend the API path (e.g. `/alibaba/icbu/product/list`);
 *   5. HMAC-SHA256 the result with the app secret, uppercase hex output.
 *
 * The module is endpoint-agnostic and pure; it never logs or throws values.
 */

import { createHmac } from 'node:crypto';

export interface SignRequestInput {
  /** API path beginning with '/', exactly as sent to the gateway. */
  apiPath: string;
  /** Flat string params (numbers must be pre-stringified by the caller). */
  params: Record<string, string>;
  appSecret: string;
}

export function canonicalSignBase(apiPath: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .filter((key) => key !== 'sign' && params[key] !== undefined)
    .sort();
  let base = apiPath;
  for (const key of sorted) {
    base += key + params[key];
  }
  return base;
}

export function signGopRequest({ apiPath, params, appSecret }: SignRequestInput): string {
  if (!apiPath.startsWith('/')) {
    throw new Error('apiPath must start with "/"');
  }
  const base = canonicalSignBase(apiPath, params);
  return createHmac('sha256', appSecret).update(base, 'utf8').digest('hex').toUpperCase();
}
