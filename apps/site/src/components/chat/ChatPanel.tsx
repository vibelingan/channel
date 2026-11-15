import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';

/** When a nudged launcher moves: soon after the page settles, then once more. */
const NUDGE_AFTER_MS = [1_500, 12_000];

export function ChatPanel({
  open,
  onOpenChange,
  children,
  headerActions,
  triggerRef,
  launcherLabel = 'Ask our AI',
  launcherNotice,
  nudge = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  headerActions?: ReactNode;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  launcherLabel?: string;
  /** Shown as a dot on the launcher, and read out with its label. */
  launcherNotice?: string;
  /**
   * Draw the eye to the closed launcher: a short wiggle soon after the page
   * settles and once more later. Nothing moves with reduced motion; the
   * label still says what the launcher does.
   */
  nudge?: boolean;
}) {
  const localTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? localTrigger;
  const panel = useRef<HTMLDialogElement>(null);
  const wasOpen = useRef(false);
  const titleId = useId();
  const [nudging, setNudging] = useState(false);
  useEffect(() => {
    if (!nudge || open) {
      setNudging(false);
      return;
    }
    const timers = NUDGE_AFTER_MS.map((ms) => window.setTimeout(() => setNudging(true), ms));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [nudge, open]);
  useEffect(() => {
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    const frame = requestAnimationFrame(() => {
      if (open)
        (
          panel.current?.querySelector<HTMLElement>(
            'textarea:not([disabled]), input:not([disabled])',
          ) ?? panel.current?.querySelector<HTMLElement>('button')
        )?.focus();
      else if (closing) trigger.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, trigger]);
  return (
    <div
      className="fixed bottom-4 right-4 z-50 sm:bottom-6 sm:right-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          onOpenChange(false);
        }
      }}
    >
      {open && (
        <dialog
          ref={panel}
          open
          aria-modal="false"
          aria-labelledby={titleId}
          className="assistant-panel relative mb-3 ml-0 flex h-[min(42rem,calc(100svh-7rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[1.25rem] border border-slate-200 bg-white p-0 text-ink shadow-2xl"
        >
          <header className="flex shrink-0 items-center justify-between bg-brand-950 px-4 py-3 text-white">
            <div className="flex min-w-0 items-center gap-3">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                className="h-6 w-6 shrink-0 text-brand-200"
              >
                <path
                  d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"
                  fill="currentColor"
                />
              </svg>
              <div>
                <h2 id={titleId} className="font-display text-sm font-semibold">
                  Product assistant
                </h2>
                <p className="mt-1 text-[11px] text-slate-300">
                  Find products. Shape your project.
                </p>
              </div>
            </div>
            <div className="flex items-center">
              {headerActions}
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Close assistant"
                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-xl text-slate-200 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
              >
                ×
              </button>
            </div>
          </header>
          {children}
        </dialog>
      )}
      <button
        ref={trigger}
        type="button"
        onClick={() => onOpenChange(!open)}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setNudging(false);
        }}
        aria-expanded={open}
        data-nudging={nudging || undefined}
        className={`relative ml-auto flex min-h-11 items-center gap-2 rounded-full bg-brand-950 px-5 py-3 text-sm font-semibold text-white shadow-xl hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${nudging ? 'motion-safe:animate-launcher-nudge' : ''}`}
      >
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-full bg-accent-500 text-brand-950 ${nudging ? 'motion-safe:animate-launcher-spark' : ''}`}
          aria-hidden="true"
        >
          ✦
        </span>
        {launcherLabel}
        {launcherNotice && (
          <>
            <span
              data-launcher-notice
              className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-red-600"
              aria-hidden="true"
            />
            <span className="sr-only">{` · ${launcherNotice}`}</span>
          </>
        )}
      </button>
      <noscript>
        <a
          href="/#oem-inquiry"
          className="mt-2 block text-sm font-semibold text-brand-700 underline"
        >
          Contact our team
        </a>
      </noscript>
    </div>
  );
}
