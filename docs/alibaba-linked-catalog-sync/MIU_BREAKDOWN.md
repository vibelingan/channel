# MIU Breakdown — Channel Alibaba Open Platform Linked Catalog Sync

Each MIU is implemented, tested, reviewed, committed, and test-deployed independently where runtime-affecting.

## MIU 0 — Baseline and live contract evidence

**Goal:** freeze the real starting point without changing runtime behavior.

- rebase branch on latest `origin/main`;
- copy docs to `docs/alibaba-linked-catalog-sync/`;
- record exact commit and current test counts;
- verify Alibaba app permissions, OAuth callback registration, gateway paths, signature vector, product list/detail response fixtures, pagination/window fields, money lexemes, and source IDs;
- verify current CloudBase transaction and timer-trigger deployment contracts;
- verify all protected legacy pricing surfaces remain present.

**Done:** evidence file committed; no unresolved response-shape ambiguity; no runtime code edits.

## MIU 1 — Alibaba pricing types and money parser

**Files:** `packages/alibaba-catalog-sync/src/alibaba-money.ts`, `alibaba-pricing.ts`, tests.

- implement minor-unit parser;
- implement fixed/range/tiered/negotiable/unavailable validation;
- reject floating-point inputs and malformed tiers;
- define `AlibabaCatalogPricing` and `AlibabaPriceTier`.

**Done:** golden/edge/mutation tests green.

## MIU 2 — Alibaba signature, client, and enumeration

- signed request canonicalization and golden vector;
- timeout/retry/redaction policy;
- product list/detail contracts;
- 5,000-item range bisection and deterministic dedupe;
- redacted fixtures from granted API.

**Done:** no undocumented endpoint or scraping path; tests green.

## MIU 3 — Alibaba-prefixed registry collections and additive product fields

- add `adminAccess` registry policy;
- register all Alibaba-prefixed collections;
- add read-only Alibaba product fields;
- preserve every legacy pricing definition unchanged;
- add resource/index provisioning and contract tests.

**Done:** generic admin access matrix green; legacy field snapshot test proves no deletion/rename/change.

## MIU 4 — DB deterministic writes and Alibaba sync lease

- `createDocWithId` and `upsertDocWithId`;
- provider-specific acquire/renew/release/assert lease methods;
- CloudBase transactional implementation;
- local JSON parity;
- fencing and stale-holder tests;
- leave image mutation ownership unchanged.

**Done:** concurrency tests prove one holder and stale promotion rejection.

## MIU 5 — OAuth and encrypted Alibaba connection

- admin-authenticated OAuth start;
- ten-minute single-use hashed state;
- replay-safe callback;
- AES-256-GCM token envelope;
- refresh/disconnect/authorization-expired state;
- secret redaction tests.

**Done:** no plaintext token in DB/log/response/alert fixtures.

## MIU 6 — Exact raw payload storage and source normalization

- private object storage before parsing;
- hash-addressing/dedupe;
- redacted metadata in `alibabaSourcePayloads`;
- normalize into `alibabaSourceProducts` and `alibabaSupplierOffers`;
- deterministic document IDs;
- abort page on raw-write failure.

**Done:** rerun idempotency and raw-before-parse tests green.

## MIU 7 — Product linking and unpublished draft projection

- unique `alibabaProductLinks` claim;
- explicit existing-product link action;
- category mapping requirement;
- unpublished draft creation;
- no fuzzy match;
- no automatic public image selection;
- no legacy price field write.

**Done:** race and publication-invariant tests green.

## MIU 8 — Primary Alibaba offer selection and fenced product promotion

- deterministic primary offer selection;
- write only Alibaba-owned additive fields;
- preserve curated and legacy fields;
- source deletion/unavailable behavior;
- transaction rechecks lease/fence and link identity;
- candidate hash and quarantine.

**Done:** before/after document tests prove protected fields unchanged.

## MIU 9 — Additive public API projection

- expose safe Alibaba product fields;
- preserve existing field allowlist and VIP gating;
- anonymous/authenticated callers receive identical Alibaba pricing;
- no new source internals exposed;
- no JWT or legacy pricing changes.

**Done:** legacy payload snapshot stays green; linked payload tests green.

## MIU 10 — Alibaba pricing renderer and compatibility routing

- add `AlibabaCatalogPricingBlock`;
- fixed/range/tiered/negotiable/unavailable rendering;
- correct CNY/USD labels;
- linked-product branch by `alibabaPrimarySourceKey`;
- no fallback to legacy values while linked;
- unlinked product legacy behavior unchanged;
- optional explanatory comment on `PriceBlock`; no deletion/refactor.

**Done:** render/E2E matrix from compatibility plan green.

## MIU 11 — Resumable runner, checkpoints, and safety guards

- incremental/full/manual/continuation state machine;
- bounded 720-second invocation;
- page checkpoints and committed cursor;
- anomaly thresholds;
- quarantine approval;
- complete-full-run tombstoning only.

**Done:** duplicate/retry/continuation/partial-full tests green.

## MIU 12 — Media candidate import

- SSRF controls, redirects, DNS/IP validation, streaming cap, MIME+magic, checksum dedupe;
- existing media lifecycle and owner lock;
- candidate-only import;
- no automatic product image assignment.

**Done:** adversarial URL/content tests and lifecycle parity green.

## MIU 13 — Admin operations UI

- Alibaba connection panel;
- manual run controls;
- run history/counters/errors;
- quarantine review;
- category mapping CRUD;
- product link action;
- secret-free UI payloads.

**Done:** role/accessibility/browser tests green.

## MIU 14 — Function manifest, packaging, deploy, gateway, and timer

- one manifest includes `admin`, `public-api`, and `alibaba-catalog-sync`;
- package/smoke/deploy consume manifest;
- test env timer absent;
- production desired timer explicit;
- drift tests for function/env/route/trigger;
- preserve existing function deployment behavior.

**Done:** all artifact/deploy contract tests green and manual test deployment succeeds.

## MIU 15 — Controlled activation and production readiness

- follow compatibility stages B–F;
- manual authorized incremental smoke;
- linked/unlinked product storefront checks;
- protected legacy field integrity report;
- rollback rehearsal;
- explicit approval before production timer;
- production incremental run and bounded full rehearsal.

**Done:** exact deployed commit, trigger state, run IDs, counts, residual limitations, and no-secret evidence recorded.
