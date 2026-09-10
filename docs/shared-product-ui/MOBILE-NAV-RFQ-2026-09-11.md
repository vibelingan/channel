# Mobile account navigation and RFQ containment — 2026-09-11

## Scope and observed causes

The user reported an account pill that only dismissed the mobile navigation,
and an RFQ/customization sheet that could move sideways on iPhone Safari.

- The mobile header reused the desktop account **button/dropdown**, not an
  anchor to Admin. A clean-browser reproduction on the deployed version stayed
  on `/headphones/` after tapping the cached admin identity. The cached name is
  not proof of a valid session. Admin's existing server `me` check still decides
  access, with expired/anonymous sessions sent to login and a return destination.
- The RFQ dialog only declared `overflow-y: auto`. Chromium and WebKit computed
  `overflow-x: auto` as well. The screenshot's physical-iPhone horizontal motion
  was reported, not reproduced on a physical phone. At the ordinary 390px sample
  the automated browsers had no intrinsic width overflow; do not attribute the
  original screenshot to a proven date-input bug.
- Expanded tests found the fixed CountryPicker portal used the scrolled native
  dialog as its positioning boundary. On a 1440x900 scrolled page this placed
  the last option below the viewport. Also, ComboBox's `scrollRef` points to
  ListBox, but scrolling was on Popover. These are separate from RFQ data/state.

## Implemented behavior

- Mobile AccountMenu has a `navigation` layout: native Admin/account anchors,
  visible account settings/sign-out actions, and an anonymous Admin portal link.
  Desktop retains its dropdown. Header link dismissal is delegated so it also
  covers links rendered after React hydration, without cancelling navigation.
- The RFQ dialog explicitly contains horizontal overflow and overscroll, accepts
  vertical touch panning and pinch zoom, and keeps ordinary vertical scrolling.
  Long text wraps; inputs, date control, fieldsets, textarea and title can shrink;
  the close control does not shrink. Steps wrap instead of forcing width.
- CountryPicker stays portaled **inside the native dialog** (body portals would
  be inert). React Aria owns viewport placement, selection, keyboard semantics
  and focus. The constrained ListBox now owns option scrolling.

No API, schema, authentication authority, pricing, publication or notification
behavior changes. No new UI framework, state store or custom touch event engine.

## Verification contract

- Account states: valid admin, expired admin, guest, ordinary member; mobile
  destination, login return URL, desktop dropdown, settings/sign-out, long names,
  and focus transfer on resizing.
- RFQ and customization: 320x568, 390x844, 568x320 landscape, 768x1024,
  1024x768 and 1440x900; all three steps, validation, date input, long unbroken
  content, country filtering/selection/Escape, Back, reopen/cancel and draft
  retention. No synthetic success receipt and no external submission.
- Assert actual control bounds, scrollWidth/clientWidth, popup bounds and touch
  hit-testing. Chromium synthetic touch gestures additionally check horizontal
  containment, working vertical scrolling and stationary background. Enlarged
  text is checked independently of gesture measurements (font resizing causes
  browser scroll anchoring and must not contaminate that measurement).
- The browser harness flushes the input-scroll event before typing: React Aria
  intentionally dismisses its popup when the trigger's parent scrolls. Touch
  selection uses a verified visible/hit-testable option, not force-click.
- Stable `@mobile-regression` tags select the two relevant suites in the
  `webkit-mobile` project. Both CI and normal post-deployment checks install
  Chromium plus WebKit and run these tests. Existing same-SHA full-CI deployment
  gates remain mandatory.

## Local verification results

On the CI Node 22.13 runtime, the final production-build/disposable-database
runner passed 41 public, 46 catalog/mobile, one font-failure, one seed, five
persisted Admin lifecycle and 11 Admin editor tests. Its formal-path variant
passed 41 public, 46 catalog/mobile and six real local database approval/RFQ/
follow-up tests. Neither final run required a retry or left fixture data behind.
The focused two-suite run passed 37 tests across Chromium/WebKit; the Chromium
390px touch case also passed five consecutive runs.

Full unit tests, TypeScript checks, tracked-source lint, CloudBase SDK contracts
and all seven deployment-gate tests passed. The local lint scope excludes only
pre-existing untracked diagnostic output; CI checks the entire clean checkout.

CI/deployed run identifiers belong in the delivery response. WebKit device
emulation and synthetic Chromium gestures do not prove physical iPhone
rubber-band/keyboard/browser-toolbar behavior.

## Reference contracts

- [CSS overflow-x computation](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow-x)
- [Touch gesture policy](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action)
- [React Aria Popover placement and scrollRef](https://react-aria.adobe.com/Popover)
- Installed `react-aria-components` 1.21.1 / `react-aria` 3.52.1 source independently
  confirms ComboBox supplies the ListBox ref for scrolling and viewport
  positioning is the default when no custom boundary is supplied.
