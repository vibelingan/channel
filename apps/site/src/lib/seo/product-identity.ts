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

/** Pending first delivery uses the existing dynamic page until HTML is verified. */
export function productBrowserPath(product: { _id: string; publicPageReady?: boolean }): string {
  return product.publicPageReady === false
    ? `/products/item/?id=${encodeURIComponent(product._id)}`
    : productPath(product._id);
}
