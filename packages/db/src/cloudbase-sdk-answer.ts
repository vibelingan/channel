/**
 * Rethrow a coded in-transaction answer with its code. Through
 * @cloudbase/node-sdk (production) such answers already throw: its request
 * layer passes any `{ code }` result to processReturn, which throws while
 * throwOnCode is true (the default; nothing here turns it off). The bare
 * @cloudbase/database API instead RETURNS `{ code, message }` (document.js:
 * `if (res.code) return res;`). This guard keeps the approval wrappers right
 * either way: a conflict is retried by runTransaction and answered BUSY,
 * never read as "missing" or "write not confirmed".
 */
export function sdkAnswer<T>(response: T): T {
  if (typeof response === 'object' && response !== null) {
    const code = Reflect.get(response, 'code');
    if (typeof code === 'string' && code) {
      const message = Reflect.get(response, 'message');
      throw Object.assign(new Error(typeof message === 'string' && message ? message : code), {
        code,
      });
    }
  }
  return response;
}
