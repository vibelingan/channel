/**
 * Inventory reconciliation.
 *
 * The merchant asked for an EXACT count on the website, and the workbook makes
 * that harder than it looks: the same physical SKU is listed in several
 * stores, and each store's row reports the stock it can see. Those rows
 * usually mirror one warehouse, so adding them up multiplies the real stock by
 * the number of stores — a listing with 40 units in four stores would advertise
 * 160 and oversell by 120.
 *
 * So nothing here ever sums. Four outcomes, and one of them is "we don't know":
 *
 *   1. one usable quantity                  -> use it
 *   2. several stores, all agreeing         -> use the agreed value ONCE
 *   3. several stores, disagreeing          -> conflict; keep every snapshot,
 *                                              invent no total
 *   4. no usable quantity                   -> unknown
 *
 * Cases 3 and 4 deliberately produce no number. Showing nothing is recoverable;
 * showing a fabricated count is not.
 */
import type { InventorySnapshot } from './contracts.ts';

export type InventoryResolution =
  | { state: 'known'; quantity: number; snapshots: InventorySnapshot[] }
  | { state: 'conflict'; quantities: number[]; snapshots: InventorySnapshot[] }
  | { state: 'unknown'; snapshots: InventorySnapshot[] };

function isUsable(snapshot: InventorySnapshot): boolean {
  return Number.isSafeInteger(snapshot.quantity) && snapshot.quantity >= 0;
}

/**
 * Reconcile every store's reported stock for ONE canonical SKU.
 *
 * Snapshots are returned in all cases, including conflict and unknown: the
 * operator needs to see what each store said in order to decide, and a
 * resolution that discards its evidence cannot be reviewed.
 */
export function reconcileInventory(snapshots: readonly InventorySnapshot[]): InventoryResolution {
  const kept = [...snapshots];
  const usable = kept.filter(isUsable);
  if (usable.length === 0) return { state: 'unknown', snapshots: kept };

  const distinct = [...new Set(usable.map((snapshot) => snapshot.quantity))];
  const [only] = distinct;
  if (distinct.length === 1 && only !== undefined) {
    // Covers cases 1 and 2 identically: one row, or four rows that agree.
    return { state: 'known', quantity: only, snapshots: kept };
  }
  return { state: 'conflict', quantities: distinct.sort((a, b) => a - b), snapshots: kept };
}

/**
 * The count to display, or `null` when there is nothing honest to display.
 * A conflict resolves to `null` rather than to a maximum, minimum or average:
 * each of those is a guess wearing a number's clothes.
 */
export function displayQuantity(resolution: InventoryResolution): number | null {
  return resolution.state === 'known' ? resolution.quantity : null;
}
