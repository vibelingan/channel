const API_BASE_URL = normalizeBaseUrl(import.meta.env.PUBLIC_API_BASE_URL);

function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');
}

function normalizeRelativePath(path: string): string {
  if (isAbsoluteUrl(path)) return path;
  return path.startsWith('/') ? path : `/${path}`;
}

export function apiUrl(path: string): string {
  const normalizedPath = normalizeRelativePath(path);
  if (!API_BASE_URL || isAbsoluteUrl(normalizedPath)) return normalizedPath;
  return `${API_BASE_URL}${normalizedPath}`;
}

export function apiMediaUrl(url: string): string {
  if (!url) return url;
  if (isAbsoluteUrl(url)) return url;
  if (url.startsWith('/api/') || url.startsWith('api/')) return apiUrl(url);
  return url;
}
