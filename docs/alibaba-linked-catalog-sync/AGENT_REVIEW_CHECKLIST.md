# Independent Agent Review Checklist

Review the documentation as an implementation contract against the current `vibelingan/channel` repository.

Return concrete findings only. Do not redesign based on preference.

## A. Additive compatibility

- Does any document or MIU still delete, unset, rename, or globally replace `unitPrice`, `wholesalePrice`, or `vipPrice`?
- Can the Alibaba runner write any legacy pricing field?
- Can a linked product accidentally fall back to legacy pricing when Alibaba price is unavailable?
- Is unlinked product behavior demonstrably unchanged?
- Are `PriceBlock`, VIP entitlement, bearer-token pricing, JWT provisioning, fixtures, and Overstock protected?

## B. Naming and scope

- Are new provider-owned collections, fields, packages, function, UI, and docs consistently Alibaba-prefixed?
- Are generic abstractions introduced without a second provider requirement?
- Does any stale `alibaba-sync-v3`, `catalogPrice`, or generic `integrationConnections` name remain?

## C. Pricing correctness

- Are source money lexemes preserved and parsed without floating-point arithmetic?
- Are fixed/range/tiered/negotiable/unavailable modes valid and mutually consistent?
- Is primary offer selection deterministic?
- Can multiple SKUs be collapsed into a misleading fixed price?
- Are CNY and USD labels correct?
- Do anonymous/authenticated users receive the same Alibaba pricing while legacy VIP behavior remains intact?

## D. Data ownership and linking

- Can sync overwrite curated fields or publication state?
- Can one Alibaba source product link to two Channel products under concurrency?
- Can a Channel product aggregate multiple source offers?
- Can missing category mapping create a malformed draft?
- Can worker code publish?

## E. Raw evidence and security

- Are exact bytes durable before parsing?
- Can secrets enter raw storage, fingerprints, logs, alerts, or browser responses?
- Is OAuth state random, hashed, single-use, expiry-bounded, and replay-safe?
- Are tokens encrypted with authenticated encryption and key versioning?

## F. Concurrency and long runs

- Is lease acquisition/renewal/release transactional and fenced?
- Can a stale holder update a product?
- Are duplicate timers and retries idempotent?
- Are cursors advanced only after durable work?
- Can a partial full run tombstone?
- Are continuation bounds finite?

## G. Media

- Are HTTPS, allowlist, redirects, DNS/private IP, size, timeout, MIME, magic bytes, and checksum covered?
- Does import use the existing media lifecycle and remain candidate-only?

## H. Deployment

- Does one manifest own build/package/smoke/deploy/env/route/trigger?
- Are existing admin/public-api deployments preserved?
- Can test environment accidentally receive a timer?
- Are trigger drift and runtime/env drift tested?

## Finding format

```text
Severity:
Document / section or code file / symbol:
Evidence:
Violated contract:
Minimal correction:
Architecture change required: yes/no
```
