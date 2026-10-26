/** Browser redirects accept a local path only. Validate decoded delimiters before returning the original. */
export function safeReturnPath(value: string | undefined): string | null {
  if (!value || value.length > 2048 || value !== value.trim()) return null;
  let decoded = value;
  for (let n = 0; n < 3; n++) {
    if (
      !decoded.startsWith('/') ||
      decoded.startsWith('//') ||
      decoded.includes('\\') ||
      [...decoded].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
    )
      return null;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  if (
    !decoded.startsWith('/') ||
    decoded.startsWith('//') ||
    decoded.includes('\\') ||
    [...decoded].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    return null;
  try {
    const base = 'https://local.invalid';
    const url = new URL(value, base);
    return url.origin === base ? value : null;
  } catch {
    return null;
  }
}
