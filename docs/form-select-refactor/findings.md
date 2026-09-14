# Findings

- PR #27 merged to `main` as `9ddda85593517bc9d1d2bea81c4862ce492b144f`.
- The earlier OEM fix exists on merged main as `PublicSelect.astro`, introduced by `0d2f3dc`.
- `PublicSelect` is still a native `<select>`. Its enhanced picker depends on experimental
  `appearance: base-select`; unsupported browsers, including Safari variants, display the OS picker.
- Admin has no shared single-select abstraction. Merged main contains nine raw Admin select sites:
  Product Family form, tier currency, mobile family filter, batch selector, inline selector, filter
  field/operator, select filter value, and boolean filter value. The tenth raw select overall is the public
  OEM fallback inside `PublicSelect.astro`; there is no separate native sort control.
- `CategoryFilter` is intentionally separate: it is a multi-select checkbox listbox.
- Root cause hypothesis: ownership is split by page/framework and the previous fix styled one
  instance instead of owning the single-select behavior family.
- Disconfirming check: if a real custom listbox cannot preserve hidden native constraint validation,
  form reset, or controlled Admin semantics in Chromium and WebKit, keep the native control visible
  for that specific unsupported surface and document the exception. No exception is assumed.
