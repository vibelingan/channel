# Product Category Select Architecture Comparison

> G3 adjustment evidence, 2026-07-28. Browser and package facts were checked against current MDN/official documentation and exact published packages. No candidate package was installed in the workspace.

## Decision Criteria

The shared Product Category control appears on two otherwise-static Astro pages. The load-bearing requirements are:

1. One successful control named `category`
2. Native `required`, label, reset, autofill, mobile input and form serialization
3. Visible and selectable without JavaScript
4. Branded closed state and a polished picker where the platform can support it
5. No new page-level React runtime solely for one control
6. A reusable public-form convention rather than a ProjectForm-only workaround

## Comparison

| Option | Custom popup | Native form/no-JS | React 19 | Minimal measured browser code | Fit for this repository |
|---|---|---|---|---:|---|
| Progressive customizable native select | Full custom picker in Chrome/Edge 135+; classic native fallback elsewhere | Best: one real select | Not needed | 0KB JS | **Recommended** |
| Radix Select 2.3.7 | Consistent custom popup across modern browsers | Hidden native bridge; visible no-JS fallback and validation focus need an extra protocol | Explicit peer support | 31.4KB gzip excluding React | Best library fallback if identical popup becomes mandatory |
| Headless UI Listbox 2.2.10 | Tailwind-friendly custom popup | Hidden fields; no visible no-JS control and weaker native-required contract | Explicit peer support | 34.7KB gzip excluding React | Good only if the team adopts Headless UI broadly |
| React Aria Components Select 1.19.0 | Highly complete adaptive accessible popup | Hidden native select supports submission/autofill/mobile navigation; no visible no-JS control | Peer range includes React 19 RC/stable-compatible surface | 55.1KB gzip excluding React | Strongest accessibility platform, too broad for this one control |
| Headless UI native Select | Native popup | Native form/no-JS only after React renders | Explicit peer support | 9.0KB gzip excluding React | Adds React/package for behavior the browser already supplies |

Measured code sizes are esbuild-minified/gzip minimal imports with React/React DOM external. Because homepage and `/oem` currently do not need React for this field, every React option would add hydration/runtime cost beyond the table.

## Recommended Pattern

Use one real `<select>` with three progressive layers:

1. **Baseline:** semantic classic select with labels, `name`, `required`, focus, invalid, reset and mobile-native behavior.
2. **Widely supported styling:** intentional closed control, 48px height, brand focus ring and chevron using ordinary CSS/Tailwind.
3. **Capability-gated picker styling:** under `@supports (appearance: base-select)`, opt the select and `::picker(select)` into `base-select`; style option rows, selected checkmark, open chevron, border, shadow, and viewport-safe picker.

Unsupported browsers ignore the extra select-button markup/CSS and retain a functioning classic select. The feature is not Baseline as of 2026-07-28: Chrome/Edge support it; Firefox does not; Safari support remains preview. Therefore the fallback is part of the product, not an error state.

## Why This Is Best Practice Here

This is not a universal “native is always better” rule. It follows the repository constraints:

- Native semantics and progressive enhancement eliminate a custom focus/keyboard/form state machine.
- The enhanced popup uses a current platform primitive rather than hand-written ARIA.
- Unsupported browsers degrade in appearance, not functionality.
- The two static Astro form consumers do not pay for React and a headless library.
- The team can revisit Radix when at least two shared controls require cross-browser identical popup composition or richer option content.

## Reconsideration Trigger

Re-open the library decision if any of these become mandatory:

- Pixel-identical picker chrome in current Firefox and Safari stable
- Search/filter inside the selector
- Virtualized or remote options
- Rich interactive option content
- Multiple public/admin controls adopting one headless component suite
