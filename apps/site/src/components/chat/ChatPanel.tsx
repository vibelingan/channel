import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react';

export function ChatPanel({
  open,
  onOpenChange,
  children,
  headerActions,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  headerActions?: ReactNode;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const localTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? localTrigger;
  const panel = useRef<HTMLDialogElement>(null);
  const wasOpen = useRef(false);
  const titleId = useId();
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
          className="relative mb-3 ml-0 flex h-[min(38rem,calc(100svh-7rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white p-0 text-ink shadow-2xl"
        >
          <header className="flex shrink-0 items-center justify-between bg-brand-950 px-4 py-3 text-white">
            <div>
              <h2 id={titleId} className="font-display text-sm font-semibold">
                Product assistant
              </h2>
              <p className="text-xs text-slate-300">AI answers from approved public sources</p>
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
        aria-expanded={open}
        className="ml-auto flex min-h-11 items-center gap-2 rounded-full bg-brand-950 px-5 py-3 text-sm font-semibold text-white shadow-xl hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
      >
        <span
          className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-500 text-brand-950"
          aria-hidden="true"
        >
          ✦
        </span>
        Ask our AI
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
