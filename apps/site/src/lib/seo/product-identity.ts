/** Stable identity, shared by static pages and interactive catalog links. */
export function productKey(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Unsafe public product identity');
  return `p-${id}`;
}

export function productPath(id: string): string {
  return `/products/${productKey(id)}/`;
}

export function isPlainProductClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
