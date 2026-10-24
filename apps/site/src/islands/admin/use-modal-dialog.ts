import { useEffect, useRef } from 'react';

/** Native top-layer modality supplies focus containment and background inertness. */
export function useModalDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const origin = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    // Native dialogs make the background inert but may tab into browser chrome.
    // Keep the editor's keyboard cycle inside the topmost dialog as well.
    const containTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active.closest('dialog') !== dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], [tabindex]',
        ),
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(':disabled') &&
          element.getClientRects().length > 0 &&
          element.closest('dialog') === dialog,
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && active === first && last) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last && first) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', containTab);
    return () => {
      dialog.removeEventListener('keydown', containTab);
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (origin instanceof HTMLElement && origin.isConnected)
        origin.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}
