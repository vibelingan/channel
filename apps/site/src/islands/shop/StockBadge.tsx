import { type StockStatus, stockStatus } from './api.ts';

interface Props {
  inventory?: number;
  labels?: { available?: string; low?: string; soldOut?: string };
  showCount?: boolean;
  size?: 'sm' | 'md';
}

const STYLES: Record<StockStatus, string> = {
  available: 'bg-green-100 text-green-700',
  low: 'bg-amber-100 text-amber-700',
  'sold-out': 'bg-slate-200 text-slate-500',
};

const DOT: Record<StockStatus, string> = {
  available: 'bg-green-500',
  low: 'bg-amber-500',
  'sold-out': 'bg-slate-400',
};

/** Stock-status pill derived from inventory count. */
export function StockBadge({ inventory, labels, showCount = false, size = 'sm' }: Props) {
  const status = stockStatus(inventory);
  const text =
    status === 'sold-out'
      ? (labels?.soldOut ?? 'Sold out')
      : status === 'low'
        ? (labels?.low ?? 'Low stock')
        : (labels?.available ?? 'Available');

  const sizeClass = size === 'md' ? 'px-3 py-1 text-xs' : 'px-2 py-0.5 text-[11px]';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${STYLES[status]} ${sizeClass}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[status]}`} />
      {text}
      {showCount && status !== 'sold-out' && inventory !== undefined && (
        <span className="font-normal opacity-80">· {inventory.toLocaleString()}</span>
      )}
    </span>
  );
}
