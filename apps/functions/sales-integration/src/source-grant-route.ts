export const SOURCE_GRANT_MAX_BYTES = 262144;
export const SALES_READ_MAX_BYTES = 16384;

export function salesPath(raw: string): string | null {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 2400) return null;
  const url = new URL(raw, 'http://sales.invalid');
  if (url.search) return null;
  return url.pathname.replace(/^\/api(?=\/)/, '').replace(/^\/integrations\/sales(?=\/)/, '');
}

export function salesBodyLimit(raw: string): number {
  return salesPath(raw) === '/source-grants' ? SOURCE_GRANT_MAX_BYTES : SALES_READ_MAX_BYTES;
}
