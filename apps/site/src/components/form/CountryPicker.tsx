import { countryOptions } from '@vibelingan-channel/shared/countries';
import { type Ref, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  ComboBox,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Text,
} from 'react-aria-components';

export interface CountryPickerProps {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  inputRef?: Ref<HTMLInputElement>;
  locale?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  description?: string;
  placeholder: string;
  emptyLabel: string;
  clearLabel: string;
}

/** A searchable sibling of Select, using the same visual tokens. React Aria
 * owns keyboard, focus, filtering and selection semantics; no free-text values. */
export function CountryPicker({
  name,
  label,
  value,
  onChange,
  onBlur,
  inputRef,
  locale = 'en',
  required = false,
  disabled = false,
  error,
  description,
  placeholder,
  emptyLabel,
  clearLabel,
}: CountryPickerProps) {
  const root = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    // React Aria closes overlays in document capture. Record/prevent the native
    // dialog default at window capture, before that close removes aria-expanded.
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        event.target instanceof Node &&
        root.current?.contains(event.target) &&
        root.current.querySelector('[aria-expanded="true"]')
      )
        event.preventDefault();
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, []);
  const options = useMemo(() => countryOptions(locale), [locale]);
  return (
    <div ref={root} className="min-w-0" data-country-picker>
      {/* A body portal would be inert behind a native modal dialog. Keep the
          overlay in the owning dialog, or the component root outside dialogs. */}
      <ComboBox
        name={name}
        value={value || null}
        onChange={(key) => onChange(typeof key === 'string' ? key : '')}
        defaultFilter={(label, query) => {
          const needle = query
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .toLowerCase()
            .trim();
          return (
            label
              .normalize('NFD')
              .replace(/\p{Diacritic}/gu, '')
              .toLowerCase()
              .includes(needle) ||
            options.some(
              (option) => option.label === label && option.value.toLowerCase() === needle,
            )
          );
        }}
        defaultItems={options}
        isRequired={required}
        isDisabled={disabled}
        isInvalid={!!error}
        validationBehavior="aria"
        allowsEmptyCollection
        onBlur={onBlur}
        className="min-w-0"
      >
        <Label className="mb-2 block text-sm font-medium text-ink">{label}</Label>
        <div
          className={`flex min-h-11 rounded-lg border bg-white focus-within:ring-2 focus-within:ring-brand-600/25 ${error ? 'border-red-500' : 'border-slate-300'}`}
        >
          <Input
            ref={inputRef}
            placeholder={placeholder}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg bg-transparent px-3 py-2 text-base outline-none disabled:text-slate-400"
          />
          <Button className="min-h-11 min-w-11 rounded-r-lg text-ink-muted disabled:opacity-50">
            ▾
          </Button>
        </div>
        {description && (
          <Text slot="description" className="mt-2 block text-xs text-ink-muted">
            {description}
          </Text>
        )}
        {error && (
          <Text slot="errorMessage" role="alert" className="mt-1 block text-sm text-red-700">
            {error}
          </Text>
        )}
        <Popover
          UNSTABLE_portalContainer={portal ?? undefined}
          // The portal is fixed to the viewport. Use React Aria's viewport
          // boundary, not the scrolled dialog's document-space coordinates.
          placement="top start"
          className="pointer-events-auto z-50 flex w-[var(--trigger-width)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white p-1 text-ink shadow-xl"
          maxHeight={240}
        >
          <ListBox<{ value: string; label: string }>
            // ComboBox's scrollRef points to ListBox: it must own scrolling so
            // focusing a selected option never scrolls/dismisses the outer dialog.
            className="min-h-0 overflow-auto overscroll-contain outline-none"
            renderEmptyState={() => <p className="p-3 text-sm text-ink-muted">{emptyLabel}</p>}
          >
            {(item) => (
              <ListBoxItem
                id={item.value}
                textValue={item.label}
                className="min-h-11 cursor-default rounded-md px-3 py-2 text-sm outline-none data-focused:bg-brand-50 data-selected:font-semibold"
              >
                {item.label} <span className="text-ink-muted">({item.value})</span>
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
      <div ref={setPortal} className="pointer-events-none fixed inset-0 z-50" />
      {value && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange('')}
          className="mt-1 min-h-11 text-sm text-brand-700 underline disabled:opacity-50"
        >
          {clearLabel}
        </button>
      )}
    </div>
  );
}
