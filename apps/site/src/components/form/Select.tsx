import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

type SelectOptionInput = string | SelectOption;

interface SelectProps {
  name?: string;
  id?: string;
  label?: ReactNode;
  ariaLabel?: string;
  options: readonly SelectOptionInput[];
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  form?: string;
  error?: string;
  describedBy?: string;
  className?: string;
  triggerClassName?: string;
  onChange?: (value: string) => void;
}

export function normalizeSelectOptions(options: readonly SelectOptionInput[]): SelectOption[] {
  return options.map((option) =>
    typeof option === 'string'
      ? { value: option, label: option, disabled: false }
      : { ...option, disabled: option.disabled ?? false },
  );
}

export function moveSelectIndex(
  options: readonly SelectOption[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (options.length === 0 || options.every((option) => option.disabled)) return -1;
  let nextIndex = currentIndex;
  for (let attempts = 0; attempts < options.length; attempts += 1) {
    nextIndex = (nextIndex + direction + options.length) % options.length;
    if (!options[nextIndex]?.disabled) return nextIndex;
  }
  return -1;
}

function boundaryIndex(options: readonly SelectOption[], fromEnd: boolean): number {
  const start = fromEnd ? options.length - 1 : 0;
  const direction = fromEnd ? -1 : 1;
  for (let index = start; index >= 0 && index < options.length; index += direction) {
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function Select({
  name,
  id,
  label,
  ariaLabel,
  options: optionInputs,
  value,
  defaultValue = '',
  placeholder = 'Select…',
  required = false,
  disabled = false,
  form,
  error,
  describedBy,
  className = '',
  triggerClassName = '',
  onChange,
}: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? name ?? `select-${generatedId}`;
  const triggerId = `${selectId}-trigger`;
  const listboxId = `${selectId}-listbox`;
  const options = normalizeSelectOptions(optionInputs);
  const controlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const selectedValue = controlled ? value : internalValue;
  const selectedIndex = options.findIndex((option) => option.value === selectedValue);
  const selectedOption = options[selectedIndex];
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [nativeInvalid, setNativeInvalid] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const nativeRef = useRef<HTMLSelectElement>(null);

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    const native = nativeRef.current;
    const ownerForm = native?.form;
    if (!native || !ownerForm) return;
    const reset = () => {
      if (!controlled) setInternalValue(defaultValue);
      setNativeInvalid(false);
      setOpen(false);
    };
    ownerForm.addEventListener('reset', reset);
    return () => ownerForm.removeEventListener('reset', reset);
  }, [controlled, defaultValue]);

  function choose(nextValue: string) {
    if (!controlled) setInternalValue(nextValue);
    setNativeInvalid(false);
    onChange?.(nextValue);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function openList(direction: 1 | -1 = 1) {
    if (disabled) return;
    const initialIndex =
      selectedIndex >= 0
        ? selectedIndex
        : moveSelectIndex(options, direction === 1 ? -1 : 0, direction);
    setActiveIndex(initialIndex);
    setOpen(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!open) setOpen(true);
      setActiveIndex(boundaryIndex(options, event.key === 'End'));
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (!open) openList(direction);
      else setActiveIndex((current) => moveSelectIndex(options, current, direction));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) openList();
      else if (activeIndex >= 0 && !options[activeIndex]?.disabled) {
        choose(options[activeIndex]?.value ?? '');
      }
    }
  }

  const shownError =
    error ??
    (nativeInvalid
      ? `Select ${String(label ?? ariaLabel ?? 'an option').toLowerCase()}.`
      : undefined);
  const shownErrorId = shownError ? `${selectId}-error` : undefined;
  const ariaDescribedBy = [describedBy, shownErrorId].filter(Boolean).join(' ') || undefined;

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className}`} data-shared-select>
      {label && (
        <label
          id={`${selectId}-label`}
          htmlFor={hydrated ? triggerId : selectId}
          className="block text-sm font-medium text-ink"
        >
          {label}
          {required && (
            <span className="text-red-500" aria-hidden="true">
              {' '}
              *
            </span>
          )}
        </label>
      )}
      <select
        ref={nativeRef}
        id={selectId}
        name={name}
        value={selectedValue}
        required={required}
        disabled={disabled}
        form={form}
        aria-label={ariaLabel}
        aria-labelledby={label ? `${selectId}-label` : undefined}
        aria-describedby={ariaDescribedBy}
        aria-invalid={Boolean(shownError) || undefined}
        aria-hidden={hydrated || undefined}
        tabIndex={hydrated ? -1 : undefined}
        data-select-native
        className={
          hydrated ? 'sr-only' : 'min-h-11 w-full border border-slate-300 bg-white px-3 text-sm'
        }
        onInvalid={(event) => {
          event.preventDefault();
          setNativeInvalid(true);
          requestAnimationFrame(() => triggerRef.current?.focus());
        }}
        onChange={(event) => choose(event.currentTarget.value)}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>

      {hydrated && (
        <>
          <button
            ref={triggerRef}
            id={triggerId}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: select-only combobox requires a browser-consistent custom popup.
            role="combobox"
            disabled={disabled}
            aria-label={ariaLabel}
            aria-labelledby={label ? `${selectId}-label` : undefined}
            aria-describedby={ariaDescribedBy}
            aria-invalid={Boolean(shownError) || undefined}
            aria-required={required || undefined}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={
              open && activeIndex >= 0 ? `${selectId}-option-${activeIndex}` : undefined
            }
            onClick={() => (open ? setOpen(false) : openList())}
            onKeyDown={handleKeyDown}
            className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border bg-white px-3 py-2 text-left text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-brand-600/25 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 ${
              shownError
                ? 'border-red-500'
                : open
                  ? 'border-brand-600'
                  : 'border-slate-300 hover:border-brand-400'
            } ${triggerClassName}`}
          >
            <span className={selectedOption ? 'truncate text-ink' : 'truncate text-ink-muted'}>
              {selectedOption?.label ?? placeholder}
            </span>
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 border-r-2 border-b-2 border-slate-500 transition-transform motion-reduce:transition-none ${
                open ? '-translate-y-px rotate-[225deg]' : '-translate-y-1 rotate-45'
              }`}
            />
          </button>

          {open && (
            <div
              id={listboxId}
              // biome-ignore lint/a11y/useSemanticElements: native select cannot render a browser-consistent popup.
              role="listbox"
              tabIndex={-1}
              aria-labelledby={label ? `${selectId}-label` : undefined}
              aria-label={label ? undefined : ariaLabel}
              className="absolute z-50 mt-2 max-h-80 w-full min-w-max overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl"
            >
              {options.map((option, index) => (
                <button
                  key={option.value}
                  id={`${selectId}-option-${index}`}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: ARIA option is required for the custom listbox.
                  role="option"
                  aria-selected={option.value === selectedValue}
                  disabled={option.disabled}
                  onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                  onClick={() => choose(option.value)}
                  className={`flex min-h-11 w-full items-center justify-between gap-4 rounded-md px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:text-slate-300 ${
                    index === activeIndex ? 'bg-brand-50 text-brand-900' : 'text-slate-700'
                  }`}
                >
                  <span>{option.label}</span>
                  {option.value === selectedValue && (
                    <span aria-hidden="true" className="font-semibold text-brand-700">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {shownError && (
        <p id={shownErrorId} className="mt-1.5 text-xs text-red-600" role="alert">
          {shownError}
        </p>
      )}
    </div>
  );
}
