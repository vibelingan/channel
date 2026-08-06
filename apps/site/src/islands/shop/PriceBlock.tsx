/**
 * LEGACY/MANUAL COMPATIBILITY RENDERER (docs/alibaba-linked-catalog-sync).
 * This block renders the manually-maintained wholesale/VIP pricing for
 * UNLINKED products and must not be removed or refactored by the Alibaba
 * feature; products with `alibabaPrimarySourceKey` render
 * AlibabaCatalogPricingBlock instead and never fall back here.
 */
import { formatPrice } from './api.ts';

interface Props {
  wholesaleLabel: string;
  vipLabel: string;
  vipLockedLabel: string;
  wholesalePrice?: number;
  vipPrice?: number;
  registered: boolean;
  /** href to sign-in, used by the locked VIP chip. Pass null for non-clickable chips. */
  signInHref?: string | null;
  size?: 'sm' | 'lg';
}

/** Two-tier price display. VIP price is gated behind registration. */
export function PriceBlock({
  wholesaleLabel,
  vipLabel,
  vipLockedLabel,
  wholesalePrice,
  vipPrice,
  registered,
  signInHref = '/login',
  size = 'sm',
}: Props) {
  const priceClass = size === 'lg' ? 'text-3xl' : 'text-xl';
  const lockedClass =
    'inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-ink-muted transition';
  const lockedContent = (
    <>
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      {vipLockedLabel}
    </>
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">
          {wholesaleLabel}
        </span>
        <span className={`font-display font-bold text-ink ${priceClass}`}>
          {formatPrice(wholesalePrice)}
        </span>
      </div>

      {registered ? (
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-accent-600">
            {vipLabel}
          </span>
          <span className={`font-display font-bold text-accent-600 ${priceClass}`}>
            {formatPrice(vipPrice)}
          </span>
        </div>
      ) : (
        <>
          {signInHref ? (
            <a href={signInHref} className={`${lockedClass} hover:bg-slate-200`}>
              {lockedContent}
            </a>
          ) : (
            <span className={lockedClass}>{lockedContent}</span>
          )}
        </>
      )}
    </div>
  );
}
