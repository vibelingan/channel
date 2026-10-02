# Admin classification and navigation: UI design

Status: **UI-only design implemented and locally verified after the user's authorization to complete the remaining phases; not deployed.** G1 intent and G2 layout/palette remain approved. Contract: [SPEC.md](SPEC.md). Foundation: [DESIGN.md](../../DESIGN.md), especially Admin density, dialog, focus and horizontal-scroll rules. Scope is the existing Admin, not a new design system.

## Surfaces and commands

Before this release, per-row **Classify** saved category only and bulk **Assign category** defaulted to publishing, although **Review classification and publish** just opened another confirmation. The entry points now open one shared dialog with two plainly named actions for single and multi-select alike:

| Control | Operator-facing result | Safety |
| --- | --- | --- |
| **Save classification** | Saves the selected website family/children, keeps drafts private. | Show `X already public` before submit; same-family edits to public products may immediately change live filtering. |
| **Save and publish** | Saves assignment, then publishes eligible drafts individually after the complete assignment is confirmed. | No default-on publish checkbox. For already-public or mixed public/draft selection, disable this outcome with `Select drafts separately to publish` rather than silently partially publishing. |
| **Back / Confirm save / Confirm save and publish** | Review one compact summary, go back without writing, or start the precise action named on Confirm. | Opening a dialog, changing a checkbox or previewing a supplier suggestion never writes. Confirmation invalidates when selection/revision changes. |
| **Done / Refresh statuses** | Return to the refreshed list or verify an unknown outcome. | No automatic retry of a possibly committed write; do not say `Published` until each product has a confirmed result. |

Separate existing **Publish / Disable** commands remain visibility-only operations, not category editing. Row status **Published / Disabled** remains a one-product visibility command. Bulk **Assign category** is not shown to roles the server refuses. **Clear selection** does not erase a pending or partial result. Supplier-linked products needing detail/media approval get named guidance to Edit. Existing published main-family move still requires withdrawal.

## Dialog layout and copy

Keep the existing Admin button color roles from [DESIGN.md](../../DESIGN.md) and the current toolbar: **Assign category** stays a white/brand-indigo outline; existing standalone **Publish** stays green, **Disable** slate, **Delete** red; the new **Save and publish** and its confirmation use the existing dark navy primary-action style, while **Save classification** remains an outline secondary action. Green inside the dialog denotes *confirmed success only*, not another generic primary color. This is a layout and interaction change, not a palette redesign. Use 8px controls, no floating page card. Existing shared `Select` owns family and mode inputs; there is no new dropdown state machine.

```text
Edit website classification                 [Close]
2 selected  ·  1 public / 1 draft

Website main category [Headphones       v]
Subcategories         [ ] Wired [x] Office [ ] Bluetooth
Assignment mode       [Replace          v]

Selection: 2 products · Headphones -> Office
  USB Call Center Headset; New Fashion Polka Dot... [Show all 2]

Already public: saving may change storefront filtering now.

[Save classification]  [Save and publish (unavailable: select drafts)]
```

For a single product show its name once, with its saved current-public/draft state. For 2-20 show counts and at most two names by default; expand for names and per-item statuses. Long supplier names wrap/clamp within a stable dialog width and expose the full name in the expanded view. No nested cards. The footer replaces the two actions with **Confirm save** or **Confirm save and publish** and **Back** on confirmation; the operation is not called `Review and publish`. Preserve focus on the selected outcome during review and return focus to the originating row/toolbar when closing. Escape/Close are allowed before a write; while an assignment, publication or status request is in flight, they remain disabled with a visible reason. Once the request has settled, an unknown outcome offers **Refresh statuses** or **Check later**; the latter closes with the selection and warning retained on the list.

## Progress, results and error states

Reserve a compact status band so changing text/count never shifts the actions or rows. A single `aria-live="polite"` region announces each significant change; counts use tabular numerals.

| Stage | Visible state | Operator can do |
| --- | --- | --- |
| Ready | Exact chosen outcome + affected count, no server write. | Edit choices, expand names, select Save or Save and publish. |
| Assigning | `Saving classification…` (no fabricated per-item progress). | Wait; both write commands lock against duplicate submission. |
| Publishing (current UI-only copy) | `Publishing selected products…` appears only if the existing sequential publication has not settled after a short threshold; a quick result goes straight to its verified summary. | Wait; no second write or dialog close. No per-product live counters or implication of an atomic batch. |
| Refreshing | `Checking product statuses…`; do not conflate a slow read with a failed publication. | Wait; if refresh fails, retain confirmed write receipts and show Refresh statuses. |
| Success | `N classified · M published` (or `N classified · drafts unchanged`). | Done; return to refreshed selection location without searching again. |
| Partial rejection | `N classified · M confirmed published · K need review`, named rejected/unknown/not-attempted exceptions expandable with next actions. | Inspect or Edit affected products; confirmed successes are not rolled back. |
| Unknown/timeout | `Some results were not confirmed; check statuses before retrying.` Do not call unknown outcomes success or failure. | After the request settles, Refresh statuses or Check later. Check later retains the selected IDs and a visible list warning; no automatic retry or Done-as-success. |

No background performance claim is implied: the current API has a 30-second limit per request and publishes individually; the true-batch investigation is deferred. First classify response can be slow too; do not show a fake progress percentage. An isolated Playwright fixture must hold assignment and an early/late publication request to demonstrate waiting, confirmed/partial/unknown summaries and duplicate-submit protection without displaying item-by-item progress. Actual customer latency must be measured with authorized, read-only request timing before claiming improvement.

### Sequential-publication copy in the current release

The approved layout and colors stay fixed. Disable duplicate submission immediately; if all existing per-product calls settle quickly, show confirmed results without a blinking progress indicator. After a 250 ms display threshold (not a measured SLA), show `Publishing selected products…` while sequential requests are in flight, without displaying their individual progress. At settlement summarize each confirmed success and named rejection, unknown or not-attempted result; partial success is not atomic. A lost response after a possible commit needs explicit status readback before claiming that product's final state. If readback cannot settle, Check later must preserve selection and the warning after leaving the dialog; Escape/Close uses the same guarded exit once no request is running. The user authorized this UI-only copy/timing work; the later true-batch UI is a separate design.

## Responsive shell and selection

| Width | Section navigation | Product family, bulk toolbar and table |
| --- | --- | --- |
| >=1280px | Retain existing left rail and current section highlight. | Family choices wrap rather than forming a second scrollbar; full bulk commands fit with predictable order. |
| 640-1279px | Use an accessible labeled **Section** selector, showing the current section at rest. No horizontally draggable top menu. | Existing family `Select` replaces scrolling tabs; selection count and primary **Assign category** remain visible. Secondary visibility/delete actions live in an accessible **Actions** menu. |
| <640px | Compact brand + sign out, then full-width Section selector. | Family selector on its own row; selection count and primary command stay in view. Dialog footer actions stack full width without clipped text. |

The table retains its own horizontal scroller at every width, with a visible local scroll affordance; do not force 13 columns into a phone or hide its scrollbar as a cosmetic fix. No other component (shell, section nav, family choices or dialog) can induce page-wide horizontal scrolling. At 734px the read-only production DOM measured nav contents 1104px in a 715px scroll area, table 1994px inside ~683px, `html.scrollWidth` 1799px and `body.scrollWidth` 715px; offscreen cells/buttons had clipping ancestors. That capture alone did not prove the source; later local before/after isolation identified table paint overflow. Containing paint on the table scroller removed document-wide overflow while preserving local table scroll. Exact-width E2E covered 375, 390, 734, 768, 1024 and 1440px. A 720px CSS-width check approximated 200% zoom reflow, but native browser zoom remains unverified. Preserve mouse, tap and keyboard routes to every command.

## Design audit (Phase 3.4)

- **Action clarity:** `Review and publish` describes neither the current review-only click nor the later two-write outcome. Two outcome-specific buttons and two precise confirmation labels resolve the ambiguity; G1 approved.
- **Unexpected public edit:** already-public same-family assignment can change storefront filters immediately. Current status and count appear before saving; mixed selections cannot take Save and publish without splitting. G2 approved the warning and layout.
- **Async honesty:** the earlier generic `Updating selected records` hid slow sequential publication. Show delayed waiting only when needed, then confirmed and unresolved totals with inspectable exceptions; keep duplicate-write guards and lost-response recovery without per-item live progress.
- **Accessibility:** dialog accessible name; focus-visible for every command; 40px minimum target, 44px mobile primary; associated labels, polite announced stage, keyboard-operated expansion/menu and focus return; long names and 200% zoom cannot cover focus. Avoid `outline-none` without a replacement. Screenshot-based geometry and keyboard check required.
- **Responsive:** replace the nested horizontal navigation/family scrollers, not just their visible scrollbars. Keep only table-local scrolling; verify the unexplained right-side blank region against actual bounds before CSS changes.
- **Palette (user correction):** do not recolor existing commands. The standalone [ui-prototype.html](ui-prototype.html) reuses brand-indigo outline, dark navy primary and the original semantic Publish/Disable/Delete colors. Its old per-item publishing animation is superseded; use the implemented Admin for current behavior and the prototype only for the approved palette/layout.
- **Reference:** upstream [Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md) were retrieved via GitHub page after the raw fetch failed. Relevant rules cover specific action labels, live status, visible focus, keyboard alternatives, constrained overflow, stable geometry and actionable errors. Installed UI skill and repository `DESIGN.md` agree; no new design tokens are proposed.
- **G2 approved:** user reviewed the interactive preview and explicitly retained the existing Admin button colors while approving the layout. The subsequent UI-only phases were authorized and locally verified; deployment and any live write remain separately gated.