# Shared Form Select Refactor

Status: implementation in progress; MIU 1 complete, MIU 2 next
Branch: `fix/shared-form-select`
Base: `origin/main` at `9ddda85593517bc9d1d2bea81c4862ce492b144f`

## Goal

Replace browser-native visible single-select pickers with one reusable, accessible custom listbox
interaction across public and Admin forms. Preserve form submission, validation, keyboard behavior,
disabled state, and current value semantics.

## Scope

- Public OEM `PublicSelect` must no longer rely on experimental `appearance: base-select` or expose
  the OS picker as its visible interaction.
- Add one React single-select component for Admin forms and controls.
- Migrate Product Family, tier currency, mobile family filter, batch role/status, inline edit,
  filter field/operator, select-valued filters, and boolean-valued filters.
- Keep `CategoryFilter` separate because it is a multi-select checkbox listbox, not a single select.
- Keep a real form-associated native control hidden inside the public adapter for no-JS submission
  and constraint validation. The visible hydrated control must be custom and browser-consistent.

## MIU 1 — Shared Select Interaction And Public Adapter

Status: complete

1. Write failing unit/browser tests for open/close, click selection, Arrow/Home/End navigation,
   Enter/Space selection, Escape focus return, outside click, disabled state, required validation,
   and hidden form-value synchronization.
2. Implement one reusable interaction model and React `Select` component.
3. Refactor `PublicSelect.astro` to progressive enhancement using the same interaction contract;
   native select remains only as hidden submission/no-JS fallback.
4. Validate OEM form submit/reset and mobile/desktop Chromium/WebKit visuals.

Truth condition: no visible public picker uses the browser-native popup after hydration; without
JavaScript, the native form control still exposes and submits the selected field value.

## MIU 2 — Admin Migration And Whole-Family Guard

Status: queued after MIU 1

1. Migrate every native Admin single-select in `RecordForm`, `QuantityTierPricingEditor`,
   `CollectionView`, and `FilterBuilder` to the shared React component.
2. Preserve controlled and action-reset semantics, labels, widths, capitalization, error wiring,
   product-family transitions, filter operators, boolean values, and mobile layout.
3. Add a source guard that fails if active form code introduces a visible raw `<select>` outside the
   approved hidden public fallback or specialized multi-select component.
4. Run complete site tests/typecheck/lint/build and Admin/OEM Chromium/WebKit E2E with screenshots.

Truth condition: all active single-select forms share the encapsulated component and no migrated
workflow changes its submitted value, accessibility state, or layout.

## Delivery

- Independent review and exact-SHA blessing are required before push.
- Open a separate PR against `main`; do not append this refactor to merged PR #27 or the deployed
  Catalog release branch.
- No production deployment is implied by this task.

## Errors

| Error | Resolution |
|---|---|
| `.claude/docs/PROJECT_STATUS.md` and `ARCHITECTURE.md` are absent on merged main | Used `AGENTS.md`, current code, git history, and merged Catalog handoff as authority. |
