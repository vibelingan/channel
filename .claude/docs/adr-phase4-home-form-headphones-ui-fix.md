# ADR: Home Form And Headphones UI Repair

Date: 2026-07-28
Phase: 4 (Technical Architecture)
Author: dev-pipeline cloud-design-patterns audit

## Context

The public Astro site needs a reusable Product Category control and a repaired Headphones catalog. The catalog currently hydrates successfully but all client-mounted `.reveal` wrappers stay transparent. The Headphones page also duplicates OEM/certification content, uses a placeholder hero icon, silently caps the catalog at 48 items, and contains one product whose protected image URLs fail closed. The solution must preserve native form behavior, the public catalog projection, role-gated VIP pricing, and the public media authorization gate.

## Patterns Selected

| Pattern | Why chosen | Trade-off accepted |
|---|---|---|
| Static Content Hosting | Astro HTML, CSS and JavaScript continue through the existing Web App/CDN while product media stays behind the API gate. | Static shell availability is independent from catalog/media availability, so explicit loading/fallback states are required. |
| Anti-Corruption Layer | The existing public API allowlist remains the only DB-to-browser projection; UI refactors never consume raw catalog documents. | New public fields require an explicit server projection change. |
| Materialized View | Existing `publishedRefCount` remains the canonical public-media visibility counter, reconciled by the existing idempotent dry-run backfill. | The absolute backfill requires a quiescent window and a post-run reconciliation check. |

## Patterns Considered And Rejected

| Pattern | Why rejected |
|---|---|
| Cache-Aside | Catalog responses vary by Authorization and already use private/no-cache semantics; a new client/server cache would add invalidation and entitlement risk. |
| Automatic Retry | Catalog errors need an explicit user retry. Hidden automatic retries would multiply requests and obscure the failure state. |
| Gateway Aggregation | The hero uses ordered reviewed IDs through the existing media route and the matrix uses the existing catalog API; there are no multiple services to aggregate. |
| CQRS | This remains a read-oriented catalog plus existing CRUD and counter repair. Separate read/write models would add no useful scaling boundary. |
| Strangler Fig | The work is a contained frontend decomposition, not a migration between two live systems. |
| Global Mutation Observer | Watching the entire DOM merely to rescue reveal animation adds permanent global work and preserves opacity as a failure mode. Default-visible CSS is simpler and safer. |
| Radix Select | The package is not installed. It supplies a visually hidden native select for form bubbling but no no-JavaScript native fallback; preserving fallback and visible validation would require dual rendering and atomic name ownership. |

## G3 Blockers

- None. One visible trade-off requires explicit G3 approval: Product Category uses a branded native select trigger and the platform-native option popup, not a pixel-identical custom popup.

## Architecture Decision

Use the platform as the form state machine: a shared `PublicSelect.astro` renders one real named `<select>` and imports shared Tailwind class constants. The closed control receives the approved brand treatment and chevron; the browser owns popup rendering, validation focus, mobile picker behavior, autofill and reset. Without JavaScript the control remains visible, labelled and selectable; the existing JSON/upload form submission itself still requires JavaScript. No UI dependency is added.

The Headphones hero shell remains static Astro content, while an ordered set of three reviewed image IDs is rendered through the existing gated `/api/images/:id` route by the shared SSR-first `ProductMedia client:load` component. A failed source advances once to the next reviewed gated source; only exhaustion shows the approved branded fallback. No gated bytes are copied into static hosting. The catalog island changes from `client:only` to `client:load`, renders a server-built loading shell, and exposes explicit `Load More` pagination after hydration. Client content is visible by default. The page keeps only hero, catalog/detail, inquiry CTA, and footer; canonical manufacturing and proof content stays on `/oem` and `/portfolio`.

The public API projection and media gate remain unchanged. The only server behavior adjustment is a stable catalog order (`_id asc`) for predictable pages. Offset pagination is explicitly eventual-consistency UI, not a snapshot: concurrent publication changes may shift later pages, so the client deduplicates IDs and never claims a frozen total. The existing admin-only `backfillImageRefCounts` action diagnoses and repairs derived image counters in a quiescent window.