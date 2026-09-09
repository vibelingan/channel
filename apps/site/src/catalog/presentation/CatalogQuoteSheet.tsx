import { zodResolver } from '@hookform/resolvers/zod';
import type {
  CatalogDetailVariant,
  CatalogDetailView,
} from '@vibelingan-channel/shared/catalog-detail';
import {
  type CatalogQuoteFields,
  type CatalogQuoteTarget,
  customizationTypes,
  quoteFieldsForDate,
  validateQuoteTarget,
} from '@vibelingan-channel/shared/catalog-quote';
import { countryName } from '@vibelingan-channel/shared/countries';
import { useContext, useEffect, useId, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { CountryPicker } from '../../components/form/CountryPicker.tsx';
import type { SharedDetailContent } from '../../i18n/catalog.ts';
import {
  type QuoteDraftState,
  currentQuoteDraft,
  quoteContextKey,
} from '../application/catalog-quote-draft.ts';
import {
  CatalogLocalPreviewContext,
  CatalogQuoteTransportContext,
} from '../application/catalog-quote-transport.ts';

const requirements: (keyof CatalogQuoteFields)[] = [
  'intent',
  'quantity',
  'deliveryDate',
  'customizationTypes',
  'brief',
];
const localDay = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
export function CatalogQuoteSheet({
  open,
  onClose,
  target,
  detail,
  variant,
  blocked,
  quantity,
  onQuantityChange,
  copy,
}: {
  open: boolean;
  onClose: () => void;
  target: CatalogQuoteTarget;
  detail: CatalogDetailView;
  variant?: CatalogDetailVariant;
  blocked: boolean;
  quantity: string;
  onQuantityChange: (value: string) => void;
  copy: SharedDetailContent;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const text = copy.rfq;
  const transport = useContext(CatalogQuoteTransportContext);
  const localPreview = useContext(CatalogLocalPreviewContext);
  const sending = useRef(false);
  const attempt = useRef<{ signature: string; key: string } | undefined>(undefined);
  const [submission, setSubmission] = useState<
    | { status: 'idle' | 'sending' }
    | { status: 'saved'; requestId: string }
    | { status: 'error'; code: string }
  >({ status: 'idle' });
  const [state, setState] = useState<QuoteDraftState>({
    step: 'requirements',
    key: quoteContextKey(target),
  });
  const [contextError, setContextError] = useState(false);
  const stepState = currentQuoteDraft(state, target);
  const step = stepState.step;
  const {
    register,
    control,
    handleSubmit,
    trigger,
    setFocus,
    setValue,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<CatalogQuoteFields>({
    resolver: zodResolver(quoteFieldsForDate(localDay()), undefined, { mode: 'sync' }),
    defaultValues: {
      intent: target.intent,
      quantity,
      deliveryDate: '',
      customizationTypes: [],
      brief: '',
      contactName: '',
      email: '',
      company: '',
      country: '',
    },
    shouldUnregister: false,
  });
  // Reopening keeps buyer text in memory but always starts a fresh review. No
  // localStorage, URL/contact serialization, transport, or synthetic receipt.
  const wasOpen = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !wasOpen.current) {
      setState({ step: 'requirements', key: quoteContextKey(target) });
      setValue('intent', target.intent);
      setValue('quantity', quantity);
      if (target.intent === 'variant_quote') setValue('customizationTypes', []);
      clearErrors();
      setContextError(false);
      setSubmission({ status: 'idle' });
      element.showModal();
      // Stop any smooth focus/anchor scroll already started before showModal.
      // The open-state CSS prevents new background scrolls, but does not cancel
      // an animation that is already in flight.
      window.scrollTo({ left: window.scrollX, top: window.scrollY, behavior: 'instant' });
      heading.current?.focus({ preventScroll: true });
    } else if (!open && element.open) element.close();
    wasOpen.current = open;
  }, [open, target, quantity, setValue, clearErrors]);
  useEffect(() => {
    // Each newly displayed step starts at its heading, not a now-hidden field.
    void step;
    if (open) {
      // A native dialog has its own scroll container. Focusing without this can
      // animate the underlying smooth-scrolling page and dismiss nested popovers.
      dialog.current?.scrollTo({ top: 0, behavior: 'instant' });
      heading.current?.focus({ preventScroll: true });
    }
  }, [step, open]);
  const current = {
    available: !blocked,
    productId: detail._id,
    revision: detail.revision ?? '',
    ...(variant ? { variant: { id: variant.id, productId: detail._id } } : {}),
  };
  const checkContext = () => {
    const failed = !!validateQuoteTarget(target, current);
    setContextError(failed);
    return !failed;
  };
  const advance = async () => {
    if (!checkContext()) return;
    if (step === 'requirements') {
      if (await trigger(requirements, { shouldFocus: true }))
        setState({ step: 'contact', key: quoteContextKey(target) });
      return;
    }
    // Revalidate all fields on every review, including hidden requirements.
    await handleSubmit(
      (fields) => {
        if (!checkContext()) return;
        // A form may stay open over midnight. Validate against a fresh day at
        // the review boundary, not only the resolver created at render time.
        const fresh = quoteFieldsForDate(localDay()).safeParse(fields);
        if (!fresh.success) {
          setState({ step: 'requirements', key: quoteContextKey(target) });
          setError('deliveryDate', { type: 'validate', message: 'delivery-date' });
          requestAnimationFrame(() => setFocus('deliveryDate'));
          return;
        }
        if (fields.intent !== target.intent) {
          setContextError(true);
          setState({ step: 'requirements', key: quoteContextKey(target) });
          return;
        }
        setState({ step: 'review', key: quoteContextKey(target), fields });
      },
      (invalid) => {
        const requirement = requirements.find((name) => invalid[name]);
        if (requirement) {
          setState({ step: 'requirements', key: quoteContextKey(target) });
          requestAnimationFrame(() => setFocus(requirement));
        }
      },
    )();
  };
  const error = (name: keyof CatalogQuoteFields) =>
    errors[name] ? (
      <p id={`${id}-${name}-error`} className="mt-1 text-sm text-red-700" role="alert">
        {text.errors[errors[name]?.message ?? ''] ?? text.errors.required}
      </p>
    ) : null;
  const field = (
    name: 'quantity' | 'deliveryDate' | 'brief' | 'contactName' | 'email' | 'company' | 'country',
    label: string,
    options?: { type?: string; maxLength?: number; autoComplete?: string },
  ) => (
    <div>
      <label className="mb-2 block text-sm font-medium" htmlFor={`${id}-${name}`}>
        {label}
      </label>
      {name === 'brief' ? (
        <textarea
          id={`${id}-${name}`}
          rows={4}
          maxLength={2000}
          {...register(name)}
          aria-invalid={!!errors[name]}
          aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
          className="w-full rounded-lg border border-slate-300 p-3 text-base"
        />
      ) : (
        <input
          id={`${id}-${name}`}
          type={options?.type ?? 'text'}
          inputMode={name === 'quantity' ? 'numeric' : undefined}
          min={name === 'deliveryDate' ? localDay() : undefined}
          maxLength={options?.maxLength}
          autoComplete={options?.autoComplete}
          {...register(
            name,
            name === 'quantity'
              ? { onChange: (event) => onQuantityChange(event.target.value) }
              : undefined,
          )}
          aria-invalid={!!errors[name]}
          aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
          className="min-h-11 w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-base"
        />
      )}
      {error(name)}
    </div>
  );
  const review = stepState.step === 'review' ? stepState.fields : undefined;
  const send = async () => {
    if (
      !transport ||
      !review ||
      sending.current ||
      submission.status === 'saved' ||
      !checkContext()
    )
      return;
    const signature = JSON.stringify({ target, fields: review });
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    sending.current = true;
    setSubmission({ status: 'sending' });
    try {
      const result = await transport({
        target,
        fields: review,
        idempotencyKey: attempt.current.key,
      });
      setSubmission(
        result.ok
          ? { status: 'saved', requestId: result.requestId }
          : { status: 'error', code: result.code },
      );
    } catch {
      setSubmission({ status: 'error', code: 'uncertain' });
    } finally {
      sending.current = false;
    }
  };
  return (
    <dialog
      ref={dialog}
      data-catalog-quote-sheet
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-notice`}
      onCancel={(event) => {
        event.preventDefault();
        if (!sending.current) onClose();
      }}
      onClose={onClose}
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-0 text-ink shadow-xl backdrop:bg-brand-950/50 sm:inset-0 sm:m-auto sm:w-[min(44rem,calc(100%-2rem))] sm:rounded-2xl"
    >
      <div className="p-5 sm:p-8">
        <div className="flex items-start justify-between gap-3">
          <h2
            ref={heading}
            tabIndex={-1}
            id={`${id}-title`}
            className="font-display text-xl font-semibold outline-none"
          >
            {target.intent === 'variant_quote' ? copy.inquiryLabel : text.customizationAction}
          </h2>
          <button
            type="button"
            disabled={submission.status === 'sending'}
            onClick={onClose}
            className="min-h-11 rounded-lg border px-3 text-sm"
          >
            {text.close}
          </button>
        </div>
        <p
          id={`${id}-notice`}
          className="mt-3 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-ink-soft"
        >
          {localPreview ? text.localNotice : text.reviewNotice}
        </p>
        <div
          className="mt-5 rounded-lg bg-surface-alt p-4 text-sm"
          data-rfq-context
          data-configuration-id={variant?.id ?? detail._id}
        >
          <p className="font-semibold break-words">{detail.name}</p>
          {variant && (
            <p className="mt-2 break-words">
              {variant.options.map((option) => `${option.name}: ${option.value}`).join(' · ')}
            </p>
          )}
          {variant?.sku && (
            <p className="mt-2 break-all text-xs text-ink-muted">SKU: {variant.sku}</p>
          )}
          <p className="mt-2 text-xs text-ink-muted">{copy.sourceNote}</p>
        </div>
        <ol
          aria-label={text.stepsLabel}
          className="my-6 flex gap-4 text-xs font-semibold text-ink-muted"
        >
          {(['requirements', 'contact', 'review'] as const).map((name, index) => (
            <li
              key={name}
              aria-current={step === name ? 'step' : undefined}
              className={step === name ? 'text-brand-700' : ''}
            >
              {index + 1}. {text.steps[name]}
            </li>
          ))}
        </ol>
        {(contextError || state.key !== quoteContextKey(target)) && (
          <p role="alert" className="mb-4 text-sm text-red-700">
            {text.contextChanged}
          </p>
        )}
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (step !== 'review') void advance();
          }}
        >
          <input type="hidden" {...register('intent')} />
          <fieldset hidden={step !== 'requirements'} className="min-w-0 space-y-5">
            <legend className="sr-only">{text.steps.requirements}</legend>
            {field('quantity', copy.quantityLabel, { maxLength: 16 })}
            <p className="text-xs leading-5 text-ink-muted">{text.quantityPolicy}</p>
            {field('deliveryDate', text.deliveryDate, { type: 'date' })}
            {target.intent === 'customization' && (
              <fieldset>
                <legend className="mb-2 text-sm font-medium">{text.customizationTypes}</legend>
                <div className="grid grid-cols-2 gap-2">
                  {customizationTypes.map((value) => (
                    <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        value={value}
                        {...register('customizationTypes')}
                        aria-invalid={!!errors.customizationTypes}
                        aria-describedby={
                          errors.customizationTypes ? `${id}-customizationTypes-error` : undefined
                        }
                      />
                      {text.types[value]}
                    </label>
                  ))}
                </div>
                {error('customizationTypes')}
              </fieldset>
            )}
            {field('brief', target.intent === 'customization' ? text.customBrief : text.notes)}
          </fieldset>
          <fieldset hidden={step !== 'contact'} className="min-w-0 space-y-5">
            <legend className="sr-only">{text.steps.contact}</legend>
            {field('contactName', text.contactName, { maxLength: 120, autoComplete: 'name' })}
            {field('email', text.email, { maxLength: 254, type: 'email', autoComplete: 'email' })}
            {field('company', text.company, { maxLength: 200, autoComplete: 'organization' })}
            <Controller
              name="country"
              control={control}
              render={({ field: country }) => (
                <CountryPicker
                  name={country.name}
                  value={country.value}
                  onChange={country.onChange}
                  onBlur={country.onBlur}
                  inputRef={country.ref}
                  label={text.country}
                  required
                  placeholder={text.countryPlaceholder}
                  emptyLabel={text.countryEmpty}
                  clearLabel={text.countryClear}
                  description={text.countryHelp}
                  {...(errors.country
                    ? { error: text.errors.country ?? text.errors.required }
                    : {})}
                />
              )}
            />
          </fieldset>
          {review && (
            <section data-rfq-review className="space-y-4 text-sm">
              <h3 className="text-base font-semibold">{text.steps.review}</h3>
              <dl className="space-y-3 break-words">
                {[
                  [copy.quantityLabel, review.quantity],
                  [text.deliveryDate, review.deliveryDate || text.notSpecified],
                  [text.contactName, review.contactName],
                  [text.email, review.email],
                  [text.company, review.company],
                  [text.country, countryName(review.country)],
                  ...(review.intent === 'customization'
                    ? [
                        [
                          text.customizationTypes,
                          review.customizationTypes.map((value) => text.types[value]).join(', '),
                        ],
                      ]
                    : []),
                  [text.notes, review.brief || text.notSpecified],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-ink-muted">{label}</dt>
                    <dd className="mt-1 whitespace-pre-wrap font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="rounded-lg bg-brand-50 p-3 leading-6 text-brand-800">
                {text.reviewNotice}
              </p>
            </section>
          )}
          {submission.status === 'saved' && (
            <output
              data-rfq-receipt
              className="mt-5 block rounded-lg bg-green-50 p-4 text-sm text-green-900"
            >
              {text.saved} <span className="block break-all font-mono">{submission.requestId}</span>
            </output>
          )}
          {submission.status === 'error' && (
            <p role="alert" className="mt-5 text-sm text-red-700">
              {text.submitErrors[submission.code] ?? text.submitErrors.uncertain}
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-3 border-t border-slate-200 pt-5">
            {step !== 'requirements' && submission.status !== 'saved' && (
              <button
                type="button"
                disabled={submission.status === 'sending'}
                onClick={() => {
                  setState({
                    step: step === 'review' ? 'contact' : 'requirements',
                    key: quoteContextKey(target),
                  });
                  clearErrors();
                }}
                className="min-h-11 rounded-lg border px-4 py-2 font-medium"
              >
                {text.back}
              </button>
            )}
            {step === 'review' ? (
              <button
                type="button"
                disabled={
                  !transport || submission.status === 'sending' || submission.status === 'saved'
                }
                onClick={() => void send()}
                className="min-h-11 rounded-lg bg-accent-500 px-4 py-2 font-semibold disabled:opacity-50"
              >
                {!transport
                  ? text.sendUnavailable
                  : submission.status === 'sending'
                    ? text.sending
                    : localPreview
                      ? text.sendLocal
                      : text.send}
              </button>
            ) : (
              <button
                type="submit"
                className="min-h-11 rounded-lg bg-brand-700 px-5 py-2 font-semibold text-white"
              >
                {step === 'requirements' ? text.continue : text.review}
              </button>
            )}
          </div>
        </form>
      </div>
    </dialog>
  );
}
