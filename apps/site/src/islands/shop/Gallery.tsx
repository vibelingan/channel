import { useRef, useState } from 'react';

interface Props {
  images: string[];
  alt: string;
  zoomHint: string;
}

/**
 * Product gallery with thumbnails and an eBay-style hover-zoom: moving the
 * cursor over the main image pans a magnified view via background-position.
 * Zoom is pointer-only (skipped on touch / coarse pointers).
 */
export function Gallery({ images, alt, zoomHint }: Props) {
  const list = images.length > 0 ? images : ['/api/images/_placeholder'];
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [pos, setPos] = useState({ x: 50, y: 50 });
  const frameRef = useRef<HTMLDivElement>(null);

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setPos({ x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) });
  }

  const src = list[active];

  return (
    <div>
      <div
        ref={frameRef}
        className="relative aspect-square overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-surface-alt"
        onMouseEnter={() => {
          if (window.matchMedia('(pointer: fine)').matches) setZoom(true);
        }}
        onMouseLeave={() => setZoom(false)}
        onMouseMove={onMove}
      >
        {/* Base image */}
        <img
          src={src}
          alt={alt}
          className={`h-full w-full object-cover transition-opacity duration-200 ${
            zoom ? 'opacity-0' : 'opacity-100'
          }`}
        />
        {/* Zoom layer */}
        {zoom && (
          <div
            className="absolute inset-0 bg-no-repeat"
            style={{
              backgroundImage: `url(${src})`,
              backgroundSize: '200%',
              backgroundPosition: `${pos.x}% ${pos.y}%`,
            }}
            aria-hidden="true"
          />
        )}
        {!zoom && (
          <span className="pointer-events-none absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-medium text-ink-muted shadow-sm">
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3M11 8v6M8 11h6" strokeLinecap="round" />
            </svg>
            {zoomHint}
          </span>
        )}
      </div>

      {list.length > 1 && (
        <div className="mt-4 flex gap-3">
          {list.map((img, i) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: gallery order is fixed and images may repeat
              key={i}
              type="button"
              onClick={() => setActive(i)}
              className={`h-20 w-20 overflow-hidden rounded-lg border-2 bg-surface-alt transition ${
                i === active ? 'border-brand-600' : 'border-transparent hover:border-slate-300'
              }`}
              aria-label={`View image ${i + 1}`}
            >
              <img src={img} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
