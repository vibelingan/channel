/** Read only the canonical answer string, never a query, action or JSON metadata.
 * Other field orders simply wait for the fully validated final plan.
 */
export function answerPrefix(raw: string): string {
  const head = /^\s*\{\s*"kind"\s*:\s*"answer"\s*,\s*"text"\s*:\s*"/.exec(raw);
  if (!head) return '';
  let encoded = '';
  for (let i = head[0].length; i < raw.length; i++) {
    const char = raw.charAt(i);
    if (char === '"') break;
    if (char === '\\') {
      const rest = raw.slice(i);
      const escaped = /^\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/.exec(rest)?.[0];
      if (!escaped) break;
      encoded += escaped;
      i += escaped.length - 1;
    } else {
      if (char.charCodeAt(0) < 32) return '';
      encoded += char;
    }
  }
  try {
    return JSON.parse(`"${encoded}"`) as string;
  } catch {
    return '';
  }
}

/** Sentence boundaries reduce database writes and keep commercial-value checks intact. */
export function completeAnswerPrefix(raw: string): string {
  const text = answerPrefix(raw);
  const boundary = /[。！？.!?\n](?=\s|$|[㐀-鿿])/g;
  let end = 0;
  for (const match of text.matchAll(boundary)) end = match.index + match[0].length;
  return text.slice(0, end);
}
