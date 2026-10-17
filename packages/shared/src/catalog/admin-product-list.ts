/** Admin list DTO protocol. Never persist these response-only markers. */
export const ADMIN_PRODUCT_LIST_VIEW = 'admin-product-list-v1' as const;
export const ADMIN_PRODUCT_LIST_MARKER = '_adminProductListView' as const;
export type AdminProductListView = typeof ADMIN_PRODUCT_LIST_VIEW;

export const ADMIN_PRODUCT_LIST_ROW_MAX_BYTES = 8 * 1024;
export const ADMIN_PRODUCT_LIST_ROW_MAX_DEPTH = 24;
export const ADMIN_PRODUCT_LIST_PAGE_MAX_BYTES = 1024 * 1024;
export const ADMIN_PRODUCT_LIST_LIMITED = '_adminProductListLimited' as const;
export const ADMIN_PRODUCT_LIST_CORE_INCOMPLETE = '_adminProductListCoreIncomplete' as const;
export const PRODUCT_LIST_DETAILS_LABEL = 'View in Preview';
export const PRODUCT_LIST_CORE_MESSAGE = 'Open Edit for full product details.';
export const PRODUCT_LIST_SELECTION_MESSAGE =
  'Use Edit or Preview for the selected products, or remove them from the selection.';

const encoder = new TextEncoder();
/** Check JSON wire bytes without serializing an oversized row or recursing through a deep tree. */
export function fitsJsonBudget(value: unknown, maxBytes: number, maxDepth = 32): boolean {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > 32
  )
    return false;
  let remaining = maxBytes;
  const stack: { value: unknown; depth: number; inArray?: boolean }[] = [{ value, depth: 0 }];
  const stringBytes = (text: string): number =>
    text.length + 2 > remaining ? remaining + 1 : encoder.encode(JSON.stringify(text)).byteLength;
  while (stack.length) {
    const entry = stack.pop();
    if (!entry || entry.depth > maxDepth) return false;
    const item = entry.value;
    if (item === null || (item === undefined && entry.inArray)) remaining -= 4;
    else if (typeof item === 'string') remaining -= stringBytes(item);
    else if (typeof item === 'boolean') remaining -= item ? 4 : 5;
    else if (typeof item === 'number') remaining -= Number.isFinite(item) ? String(item).length : 4;
    else if (Array.isArray(item)) {
      remaining -= 2 + Math.max(0, item.length - 1);
      if (remaining < 0) return false;
      for (const child of item) stack.push({ value: child, depth: entry.depth + 1, inArray: true });
    } else if (item && typeof item === 'object') {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) return false;
      remaining -= 2;
      let first = true;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        const child = Reflect.get(item, key);
        if (child === undefined) continue;
        remaining -= stringBytes(key) + 1 + (first ? 0 : 1);
        first = false;
        if (remaining < 0) return false;
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    } else return false;
    if (remaining < 0) return false;
  }
  return true;
}
export function productListLimited(doc: Record<string, unknown>): boolean {
  return (
    doc[ADMIN_PRODUCT_LIST_MARKER] === ADMIN_PRODUCT_LIST_VIEW &&
    doc[ADMIN_PRODUCT_LIST_LIMITED] === true
  );
}
export function productListCoreIncomplete(doc: Record<string, unknown>): boolean {
  return productListLimited(doc) && doc[ADMIN_PRODUCT_LIST_CORE_INCOMPLETE] === true;
}
export function isAdminProductListRow(doc: Record<string, unknown>): boolean {
  return (
    typeof doc._id === 'string' &&
    doc._id.length > 0 &&
    doc[ADMIN_PRODUCT_LIST_MARKER] === ADMIN_PRODUCT_LIST_VIEW &&
    (!Object.hasOwn(doc, ADMIN_PRODUCT_LIST_LIMITED) || doc[ADMIN_PRODUCT_LIST_LIMITED] === true) &&
    (!Object.hasOwn(doc, ADMIN_PRODUCT_LIST_CORE_INCOMPLETE) ||
      (doc[ADMIN_PRODUCT_LIST_CORE_INCOMPLETE] === true &&
        doc[ADMIN_PRODUCT_LIST_LIMITED] === true)) &&
    fitsJsonBudget(doc, ADMIN_PRODUCT_LIST_ROW_MAX_BYTES, ADMIN_PRODUCT_LIST_ROW_MAX_DEPTH)
  );
}
