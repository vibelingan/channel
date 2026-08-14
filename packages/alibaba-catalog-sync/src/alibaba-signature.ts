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

import { createHash, createHmac } from 'node:crypto';

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

/**
 * TOP (Taobao Open Platform) request signing — the protocol Alibaba.com ICBU
 * actually runs on.
 *
 * The International Station's product APIs are TOP methods
 * (`alibaba.icbu.product.list`, not a REST path), exchanged through
 * `eco.taobao.com/router/rest`. That is why the GOP helper above cannot be
 * reused: GOP prepends an API PATH and signs with HMAC-SHA256, while TOP has no
 * path (the method is an ordinary signed parameter) and signs with HMAC-MD5.
 *
 * Canonicalization (official TOP algorithm):
 *   1. drop `sign` itself, and drop any parameter with an empty key or value —
 *      TOP excludes empties, and including them yields a valid-looking
 *      signature the gateway rejects;
 *   2. sort the remaining keys by ASCII ascending;
 *   3. concatenate `key + value` pairs with no separator and no path prefix;
 *   4. HMAC-MD5 with the app secret as the key;
 *   5. uppercase hex.
 *
 * `sign_method=md5` instead wraps the base as `secret + base + secret` and
 * plain-MD5s it. Both are documented; this integration sends `hmac`.
 */
export type TopSignMethod = 'hmac' | 'md5';

export interface SignTopRequestInput {
  /** Every system + business parameter being sent, `sign` excluded or ignored. */
  params: Record<string, string>;
  appSecret: string;
  /** Defaults to 'hmac' (HMAC-MD5), which is what this integration sends. */
  signMethod?: TopSignMethod;
}

export function canonicalTopSignBase(params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .filter(
      (key) => key !== 'sign' && key !== '' && params[key] !== undefined && params[key] !== '',
    )
    .sort();
  let base = '';
  for (const key of sorted) {
    base += key + params[key];
  }
  return base;
}

export function signTopRequest({
  params,
  appSecret,
  signMethod = 'hmac',
}: SignTopRequestInput): string {
  const base = canonicalTopSignBase(params);
  if (signMethod === 'md5') {
    return createHash('md5')
      .update(`${appSecret}${base}${appSecret}`, 'utf8')
      .digest('hex')
      .toUpperCase();
  }
  return createHmac('md5', appSecret).update(base, 'utf8').digest('hex').toUpperCase();
}

/**
 * TOP timestamps are `yyyy-MM-dd HH:mm:ss` in **GMT+8**, not ISO and not UTC.
 * Sending UTC makes the gateway reject the request as an invalid timestamp
 * whenever the two differ by more than its tolerance — which is always.
 */
export function topTimestamp(atMs: number): string {
  const shifted = new Date(atMs + 8 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}
