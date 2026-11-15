import { type ReactNode, useRef, useState } from 'react';
import type { PublicProduct } from './model';

/**
 * One batch of product cards, side by side inside the message. Browsing only
 * moves through cards already received: no request, no reordering, no loop.
 * Native horizontal scrolling with snap, so vertical chat scrolling and touch
 * gestures stay the browser's own.
 */
export function ProductCarousel({
  products,
  label,
  renderCard,
}: {
  products: PublicProduct[];
  label: string;
  renderCard: (product: PublicProduct) => ReactNode;
}) {
  const track = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  const several = products.length > 1;
  function go(index: number) {
    const element = track.current;
    const card = element?.children[index];
    if (!element || !(card instanceof HTMLElement)) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Scroll the track only; scrollIntoView would also move the transcript.
    element.scrollTo({ left: card.offsetLeft, behavior: reduced ? 'auto' : 'smooth' });
    setActive(index);
  }
  function onScroll() {
    const element = track.current;
    if (!element) return;
    let nearest = 0;
    for (let i = 1; i < element.children.length; i++) {
      const card = element.children[i] as HTMLElement;
      const best = element.children[nearest] as HTMLElement;
      if (
        Math.abs(card.offsetLeft - element.scrollLeft) <
        Math.abs(best.offsetLeft - element.scrollLeft)
      )
        nearest = i;
    }
    setActive(nearest);
  }
  return (
    <section
      aria-roledescription="carousel"
      aria-label={label}
      data-product-carousel
      className="mt-3 min-w-0"
      onKeyDown={(event) => {
        if (!several || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        if (!(event.target instanceof HTMLElement) || !event.target.closest('[data-carousel-nav]'))
          return;
        event.preventDefault();
        go(
          Math.min(
            products.length - 1,
            Math.max(0, active + (event.key === 'ArrowRight' ? 1 : -1)),
          ),
        );
      }}
    >
      <ul
        ref={track}
        onScroll={several ? onScroll : undefined}
        className="relative flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain [scrollbar-width:none] motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden"
      >
        {products.map((product, index) => (
          <li
            key={product.id}
            aria-roledescription="slide"
            aria-label={`${index + 1} of ${products.length}`}
            // The next card shows about 20px on a phone and 16px on a desktop.
            className={`relative shrink-0 snap-start ${several ? 'w-[calc(100%-2rem)] sm:w-[calc(100%-1.75rem)]' : 'w-full'}`}
          >
            {several && (
              <span
                aria-hidden="true"
                className="absolute top-2 right-2 z-10 rounded-full bg-brand-950/80 px-2 py-0.5 text-xs font-semibold text-white"
              >
                {index + 1} / {products.length}
              </span>
            )}
            {renderCard(product)}
          </li>
        ))}
      </ul>
      {several && (
        <div data-carousel-nav className="mt-1 flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous product"
            disabled={active === 0}
            onClick={() => go(active - 1)}
            className="hidden min-h-11 min-w-11 items-center justify-center rounded-lg text-lg text-ink disabled:opacity-30 sm:flex"
          >
            ‹
          </button>
          <div className="mx-auto flex">
            {products.map((product, index) => (
              <button
                key={product.id}
                type="button"
                aria-label={`Show product ${index + 1} of ${products.length}`}
                aria-current={index === active ? 'true' : undefined}
                onClick={() => go(index)}
                className="flex min-h-11 min-w-11 items-center justify-center"
              >
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 rounded-full ${index === active ? 'bg-brand-700' : 'bg-slate-300'}`}
                />
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Next product"
            disabled={active === products.length - 1}
            onClick={() => go(active + 1)}
            className="hidden min-h-11 min-w-11 items-center justify-center rounded-lg text-lg text-ink disabled:opacity-30 sm:flex"
          >
            ›
          </button>
        </div>
      )}
    </section>
  );
}
