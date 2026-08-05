# Channel Portal Design Foundation

> Canonical visual and interaction foundation for public site work. Feature specifications may add local composition rules, but must cite this file and may not silently redefine its tokens or primitives.

## Design Intent

The public site is a B2B OEM/ODM sales and catalog experience. It should feel precise, established, and useful to procurement teams: real products and manufacturing evidence first, restrained brand expression second, decoration last.

Three principles govern every public surface:

1. **Show evidence, not placeholders.** Product, factory, certification, and case-study media should reveal the actual object or capability. Decorative illustrations never replace available real media.
2. **Keep repeated work predictable.** Forms, catalog cards, pricing, async states, and section rhythm use shared primitives rather than page-local imitations.
3. **Progressive enhancement is a contract.** Server-rendered content stays usable; client islands add interaction without hiding content, breaking form semantics, or shifting stable layouts.

## Tokens

Implementation tokens live in `apps/site/src/styles/tokens.css`. This document defines how they are used.

### Color

| Role | Token | Use |
|---|---|---|
| Brand foundation | `brand-700` to `brand-950` | Header accents, dark product/category heroes, primary actions |
| Interactive accent | `brand-500` to `brand-700` | Focus, active options, links, selected state |
| Conversion accent | `accent-400` to `accent-600` | One primary commercial CTA per composition |
| Text | `ink`, `ink-soft`, `ink-muted` | Heading, body, metadata hierarchy |
| Surface | `surface`, `surface-alt`, `surface-dark` | Alternating page bands; sections are not floating cards |
| Feedback | semantic red/green/amber | Error, success, warning; always paired with text or icon |

Do not introduce a second brand hue family for a single feature. Purple/pink gradients, decorative glow orbs, and low-contrast monochrome palettes are not part of this system.

### Typography

- Display: Poppins via `font-display`; page and section headings only.
- Body and controls: Inter via `font-sans`.
- Public body text: 16px minimum on mobile, 18px for lead copy.
- Compact control/card metadata: 12-14px with normal letter spacing.
- Uppercase eyebrow text may use positive tracking; ordinary labels, headings, buttons, and body copy use zero letter spacing.
- Headings use balanced wrapping where supported; user and catalog content must tolerate long unbroken values.

### Spacing And Layout

- Shared content width: `--width-container` (80rem).
- Page gutters: 16px mobile, 24px tablet, 32px desktop.
- Public section rhythm: 64-80px mobile/tablet, 80-112px desktop.
- Control stack: 6px label-to-control, 6px control-to-hint/error, 20px field-to-field.
- Breakpoint intent follows Tailwind defaults: mobile first, `sm` at 640px, `lg` at 1024px, `xl` at 1280px.
- Fixed-format media, controls, grids, and skeletons reserve dimensions before content arrives.

### Shape, Border, And Shadow

- Marketing and product cards retain the established `--radius-card` (16px).
- Form controls, buttons, status banners, and compact popovers use 8px radius.
- Pills are reserved for compact tags, counts, and trust facts, not general buttons or containers.
- Default border: slate-200/300. Focus/selected borders use brand-500/600.
- Default cards use a subtle border and `shadow-sm`; `--shadow-card` is reserved for hover, selected detail, and floating overlays.
- Do not put cards inside cards. Use bands, dividers, or unframed layout to establish hierarchy.

### Motion

- Interaction feedback: 150-250ms, explicit color/opacity/transform properties only.
- Reveal motion: opacity plus at most 24px vertical translation, one time only.
- Content mounted after initial page load must either register with the shared reveal controller or render visible immediately. A class may never default async content to permanent opacity zero.
- `prefers-reduced-motion: reduce` disables reveal and nonessential transform motion.
- Hover transforms must not change layout; touch users receive equivalent pressed/focus feedback.

## Primitive Inventory

### Page Bands And Headers

- `Section` owns full-width tone, container width, vertical rhythm, optional eyebrow/heading/intro, and anchor offset.
- A page should alternate unframed surface bands. Repeated individual products, cases, or certificates may be cards; page sections may not.
- Product/category heroes use the actual product or manufacturing scene as a first-viewport signal. Media is unframed or edge-blended, not placed inside a decorative preview card.

### Buttons And Links

- Accent button: the primary commercial action in a composition.
- Brand button: primary operational action or form submission.
- Outline/quiet button: secondary command.
- Icon-only command: familiar SVG icon, at least 40x40px hit area, accessible name and tooltip when meaning is not universal.
- Use `<button>` for actions and `<a>` for navigation. All variants require hover, pressed, disabled, and `focus-visible` states.

### Public Form Field

Every public field composes the same slots:

1. Label plus required indicator
2. Control with a stable minimum height of 48px
3. Optional hint
4. Inline error connected through accessible description

Control states are default, hover, focus-visible, filled, invalid, disabled, and busy where relevant. Focus uses a visible brand ring without removing the browser outline unless an equivalent replacement is present. Named controls retain native form association, validation, reset, autofill where applicable, and serialization. Interactive enhancement may change presentation, not the form contract.

### Single Select

- Closed trigger visually matches text inputs and shows selected text plus a chevron icon.
- Open popup aligns to trigger width, stays within viewport, caps height with internal scrolling, and uses 44px minimum option rows.
- Active, selected, and disabled are separate states; selected uses text plus a check icon, never color alone.
- Keyboard contract: Tab, Arrow keys, Home/End, Enter/Space, Escape, and typeahead.
- The implementation must preserve `name`, `required`, form association, native validation behavior, and reset. Whether this is a styled native control or a mature headless primitive is an architecture decision, not a page-local decision.

### Product Media And Card

- Media frame uses a stable square or declared aspect ratio and a neutral surface.
- Use `object-contain` for inspectable product cutouts; use `object-cover` only for deliberate lifestyle or factory photography.
- Every image has intrinsic dimensions or a reserved aspect ratio, meaningful alt text, and lazy loading below the fold.
- Failed media becomes a stable branded fallback with product name; it never loops requests or collapses the card.
- Card information order: product identity, model/code, concise description, commercial facts, price/entitlement state, command.
- Cards in one grid row maintain a stable media and information track even with uneven source descriptions.

### Async Collection State

Every client-fetched collection has four mutually exclusive states:

- Loading: skeletons matching final geometry, announced without trapping focus.
- Error: concise cause plus a specific retry action.
- Empty: explanatory copy and a next step when one exists.
- Success: count, stable grid/list, and non-vacuous visible content.

State changes that matter to assistive technology use a polite live region. A successful fetch may never depend on a one-time page-load animation to become visible.

### Dialog

Dialogs need an accessible name, initial focus, contained tab order, Escape and explicit close, backdrop handling, body scroll containment, and focus return. A dialog that only simulates a backend mutation must not claim durable success.

## Surface Composition Rules

### Marketing Pages

- Lead with literal service/product identity, evidence media, one primary CTA, and one secondary path.
- Use concise trust facts. Avoid decorative card grids when a single proof band or real image is clearer.

### Catalog Pages

- Hero identifies the product family and shows real product media.
- Catalog controls and result count precede the collection.
- Product visibility is never implied by client role styling; server projection owns entitlement, and UI communicates only the fields actually returned.
- Detail expansion or navigation must preserve orientation and focus.
- Keep catalog pages focused on product discovery, comparison, detail, and enquiry. Manufacturing process/capability belongs on `/oem`; customer, case, and certification proof belongs on `/portfolio`. Link to those canonical pages instead of repeating generic four-card marketing sections.

### Admin Surfaces

- Favor density, tables, predictable native controls, and repeated-action efficiency.
- Give dynamic tables explicit, content-aware column widths. Keep normal rows near 56px, clamp long identity/supporting text deliberately, disclose the complete value only on real overflow, and keep horizontal scrolling inside the table region.
- Public marketing polish does not justify migrating admin controls unless the shared primitive improves operator workflows and is adopted deliberately.

## Accessibility And Responsive Baseline

- WCAG AA contrast for text and interactive states.
- 40px minimum interactive target; 44px for primary mobile controls and popup options.
- Visible `focus-visible` state on every interactive element.
- Labels and controls are programmatically associated; async errors are announced.
- Validate at 375/390, 768, 1024, and 1440px, with zoom and long-content checks.
- No horizontal page scrolling. Full-bleed surfaces account for safe areas where controls approach viewport edges.
- Exact viewport browser evidence pairs screenshots with DOM geometry, computed visibility, overflow, and image state.

## Anti-Patterns

- Emoji used as interface or feature icons
- Placeholder line art when real product media exists
- Permanent `opacity: 0` as a failure mode for client-mounted content
- Page-local dropdown state machines without complete keyboard/focus/form semantics
- Duplicate pricing, media, or product-card implementations drifting across catalogs
- Generic error text with no retry or recovery path
- Simulated success presented as a completed backend workflow
- Hard-coded public media URLs tied to one current catalog row
- Generic icon-and-copy value cards duplicated onto a focused product catalog
