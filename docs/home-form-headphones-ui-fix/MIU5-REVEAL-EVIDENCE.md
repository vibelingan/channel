# MIU 5 Reveal Hardening Evidence

MIU 5 fixes a content-availability failure, not a cosmetic animation defect.

## Scenario

Before MIU 5, every `.reveal` element started at `opacity: 0` and `translateY(24px)`. Content became visible only after JavaScript created an `IntersectionObserver` and added `.is-visible`. That meant static page content could remain fully transparent when JavaScript was disabled, observer registration failed, or lifecycle timing broke.

MIU 5 changes the invariant:

- `.reveal` is visible by default.
- Only successfully observed, below-fold static elements receive a temporary pending state.
- Missing JavaScript, missing/throwing observers, and reduced motion remain visible.
- A one-time transition releases its classes and `will-change` after opacity completes or after an 800ms fallback.
- Dynamic/client content is never hidden because no `MutationObserver` is added.

## Visual Evidence

Both images use the same live `/oem#capabilities` section and 390px viewport. The first applies the old opacity-zero rule to reproduce the failure; the second removes enhancement classes to show MIU 5's fixed visible baseline.

| Old failure reproduced | MIU 5 fixed baseline |
|---|---|
| [Opacity-zero content](miu5-evidence/old-failure-390.png) | [Default-visible content](miu5-evidence/fixed-390.png) |

The visual difference is intentionally blunt: in the old state, the section heading, copy, cards, note, and factory media disappear even though they remain in the DOM. The fixed state renders all content before any observer class mutation. Browser assertions remain the authoritative gate.

## Executable Evidence

The browser suite covers:

1. visible baseline before enhancement classes;
2. `IntersectionObserver` missing;
3. observer registration throwing;
4. JavaScript disabled;
5. reduced motion;
6. one-time below-fold transition and cleanup;
7. descendant/wrong-property transition events ignored;
8. timeout cleanup when native transition completion is delayed;
9. Headphones product-card ancestor opacity regression;
10. no-JavaScript mobile horizontal overflow.

Initial MIU 5 deployment `1bcda25` built and deployed but failed the new no-JavaScript overflow gate. The reveal content itself was visible; the hidden desktop header measurement lane widened the 390px document to 480px. Follow-up `05de95b` changed hidden measurement lanes from absolute to fixed positioning, preserving intrinsic width measurements while removing document overflow. Replacement Deploy Test `30799180632` passed, including public browser E2E.

## Result

Live release `05de95b9bee94878977d5704707848494bc6a356` reports:

- no-JavaScript reveal opacity `1`;
- transform `none`;
- `scrollWidth <= innerWidth` at 390px;
- reduced-motion reveal opacity `1` with no transition;
- Headphones product cards remain visibly rendered.
