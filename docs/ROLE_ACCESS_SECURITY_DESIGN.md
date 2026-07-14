# Role, Access-Control & Customer-Data Security — Enhancement Design

Status: **V1 + V2 + V3 shipped** (V1/V2 on `fix/security-vulns-1-2` — `2eeb2b4`, `85d9757`; V3 + the authenticated catalog path on `fix/enhance-features-vip`). See §3 status markers.

> **Shipped-behavior note (V1):** the public allowlist withholds `vipPrice` from anonymous callers. The catalog routes now ALSO accept an optional `Authorization: Bearer <session-token>`: the server verifies it and re-attaches the VIP tier only when `canSeeVipPricing(role)` holds (`resolveCatalogViewer` in `apps/functions/public-api/src/handler.ts`). So entitled signed-in users (`member`/`contributor`/`admin`) see VIP pricing again, anonymous/`viewer` callers never do, and the entitlement is decided server-side — the client-side `canSeeVip` gate is now cosmetic on top of a real backend check. The storefront sends the token from `apps/site/src/islands/shop/api.ts`. Since V3 landed, the resolver re-anchors every verified token to its CURRENT users row, so suspension, demotion, and deletion revoke VIP visibility on the next request (see §3 V3).

Scope: authorization model, per-customer isolation, customer-PII handling, and the three verified vulnerabilities from the branch security review.
Source of truth for requirements: `Downloads/OEM网页资料/Diversity_Technology_Website_Upgrade_Specification.pdf` (the PRD), cross-referenced with the current handler/registry code.

---

## 1. Current state (what the code actually enforces)

- Authorization is **role-only and global**. Roles: `admin`, `contributor`, `member`, `viewer`, `''` (blank base).
- `admin` and `contributor` are **identical in reach** over content: both can list/get/create/update/remove **every record** of every content collection (`products`, `overstock`, `images`, `oemProjects`, `files`). The only admin-only extras are user management and the maintenance actions (backfill/cleanup/migrate).
- **No ownership dimension exists.** `claims.sub` (the caller's own id) is used *only* in the profile actions (`me`, `updateProfile`, `changePassword`). No content record stores a `createdBy`/`ownerId`/`customerId`, and no list/get/update/remove ever filters by owner.
- `oemProjects` (company, contact, **email**, **whatsapp**) and `files` (customer drawings) are readable and downloadable by **every** contributor.
- `submitProject` is unauthenticated and stores the customer's email as a **bare string** — there is **no link** between an OEM enquiry and a `users` account.
- Storefront pricing tiers (`member` sees VIP price, `viewer` does not) are gated **only in client-side `PriceBlock.tsx`**; the catalog is served by the **unauthenticated** public API.

## 2. What the PRD requires (grounded citations)

| PRD § | Requirement | Implication for access control |
|---|---|---|
| §4.6 Client Portal (客戶專屬中心) | Each **customer** logs in and sees **their own** project: Milestone Tracker + Document Center (contract, final BOM, QC report, B/L). *Phase-1 "reserved/design".* | Need a **client/customer role** and per-customer record + document ownership. |
| §6.3 Security & Compliance | "所有收集的客戶 Email 必須進行安全加密存儲，防範外洩"; GDPR + Cookie consent (EU/US customers). | Customer email must be **encrypted at rest** and leak-protected — a **contractual acceptance criterion**, not best practice. |
| §3 / §4.5 Leads | AI estimator + AI chat push leads (email/company/name) to a **sales backend** for a **業務員 (sales rep)** to follow up. | Need a **sales role** with leads **assigned** to / scoped by a rep. |
| §10 Phase 2 | Deliverable: "後台管理系統帳戶與權限配置" (backend accounts + permission configuration). | RBAC correctness is graded at acceptance. |

**Important scope correction:** the PRD describes the Teardown Lab / Concept Incubator as a **shared editorial CMS** ("後台能順暢地新增、修改、刪除專案"). So editor-vs-editor content ownership is **not** required — a shared content team is correct. The genuine "only see their own stuff" requirement is **customer-facing** (client portal) and **sales-facing** (leads), not internal editors.

## 3. Verified vulnerabilities (recap + fix)

These are the confirmed findings from the branch review; the fixes are folded into this design.

### V1 — Public catalog leaks role-gated pricing (High)
`apps/functions/public-api/src/handler.ts:59-61` — `publicDoc` spreads the whole DB doc to anonymous callers, including `vipPrice`/`unitPrice`/`clearancePrice`. `PriceBlock.tsx` gates `vipPrice` behind registration and never shows `unitPrice`, so those tiers are privileged by the app's own design.

**Fix:** project an explicit public allowlist; attach gated tiers only on a future authenticated catalog path that checks `canSeeVipPricing(role)` server-side.
```ts
const PUBLIC_FIELDS = ['_id','name','category','series','modName','modType',
  'description','productCode','moq','inventory','wholesalePrice','published'] as const;
function publicDoc(doc: CollectionDoc, config: PublicApiConfig): CollectionDoc {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_FIELDS) if (k in doc) out[k] = doc[k];
  out.images = catalogImages(doc, config);
  return out as CollectionDoc;
}
```

### V2 — Stored content-type confusion / XSS on image delivery (Medium)
`images.mimeType` is a writable free-form string (`collections.ts:223`); `completeUploadAction` never sniffs bytes; `binaryImage` reflects the stored `mimeType` inline with no `nosniff`.

**Fix:** (a) sniff magic bytes in `completeUploadAction` and require `png|jpeg|webp` (mirror the OEM `oemBytesMatchType`); (b) mark `images.mimeType`/`files.mimeType` `readOnly`; (c) emit `Content-Type` from a server allowlist and always add `X-Content-Type-Options: nosniff` in `binaryImage` (and the local-server image route).

### V3 — Suspended/demoted users keep access up to 12h (Medium) — **SHIPPED**
Authorization reads `claims.role` from the 12h JWT with no re-check of current `role`/`status`.

**Fix (as shipped):** `revalidateSession(claims)` in the admin handler re-fetches `users/{claims.sub}` at a single choke point immediately after `authenticate`, covering EVERY authenticated action (reads and writes). A missing row (deleted account) or `status: 'suspended'` returns `UNAUTHORIZED` (admin UI redirects to login); otherwise the claims' role is replaced with the row's **current** role, so demotion AND promotion take effect on the next request. Suspension semantics mirror `login` — only an explicit `'suspended'` revokes; legacy rows without a `status` field stay valid. The `tokenGeneration` alternative was rejected: it still needs the row read to compare generations, adds a bump-on-suspend/demote invariant to every future role-mutation path, and handles deletes no better. Cost: one `get` per authenticated request (same read `me` already does).

**Catalog path (closed in review round 4):** the PUBLIC catalog's VIP entitlement (`resolveCatalogViewer`) initially read the role from the ≤12h JWT without a row lookup, so a suspended/demoted/deleted user kept VIP *visibility* until token expiry. The original "anonymous-scale catalog" cost rationale overstated the price: the row read is only needed when a verified Bearer token is present, so anonymous traffic pays nothing. `resolveCatalogViewer` now mirrors `revalidateSession` — missing row or `status: 'suspended'` → anonymous projection, otherwise the ROW's current role decides `canSeeVipPricing` (demotion and promotion both take effect on the next request; legacy no-status rows stay valid). A failed row lookup degrades to the anonymous projection rather than erroring, so the catalog never goes down because of the entitlement check.

## 4. Target role model

| Role | Sees / does | Today |
|---|---|---|
| **admin** | Everything incl. user + permission management | ✅ |
| **contributor** (content editor) | Shared CMS: products, overstock, teardowns, concepts, portfolio, images | ✅ (keep shared) |
| **sales** | OEM enquiries + leads **assigned to them**; customer contact info for those | ❌ new |
| **client** (customer) | **Only their own** projects, milestones, documents | ❌ new role + no data linkage |
| **member / viewer / ''** | Storefront browsing; VIP-pricing entitlement via `canSeeVipPricing` | ✅ (enforce server-side, see V1) |

New shared entitlement predicate:
```ts
// packages/shared/src/auth.ts
export function canAccessAllRecords(role: Role): boolean { return role === 'admin'; }
export function isSalesRole(role: Role): boolean { return role === 'sales' || role === 'admin'; }
export function isClientRole(role: Role): boolean { return role === 'client'; }
```

## 5. Data-model changes

1. **`oemProjects`** — add server-managed, `readOnly` fields:
   - `customerId?: string` — set to `claims.sub` when a signed-in customer submits; else empty (anonymous lead).
   - `assignedTo?: string` — sales-rep user id (admin/sales assignment).
2. **New `documents` collection** (client-portal deliverables, §4.6): `projectId`, `customerId`, `kind` (`contract|bom|qc-report|bl`), storage fields (reuse the `files`/media-storage pattern), `visibleToClient: boolean`. Bytes go through the existing signed-URL/temp-URL delivery — **never** inline.
3. **New `milestones` collection** (or embedded on the project): ordered stages + status/percentage (§4.6 tracker).
4. **`users`** — extend `role` options with `sales` and `client`.
5. **Customer email encryption (§6.3):** store OEM/lead email as `emailEnc` (authenticated encryption, key from env/KMS) plus `emailHashHmac` (HMAC for dedupe/lookup — reuse the existing `findByField` pattern on the hash, never on plaintext). Decrypt only in the sales/admin detail view; redact for roles that don't need it (generalize the existing `redact()` helper). Retire the plaintext `email` column via migration.

## 6. Enforcement design (handler)

- **Owner-scoped reads/writes.** Introduce a helper applied in `listAction`/`getAction`/`updateAction`/`removeAction`:
  - if `canAccessAllRecords(claims.role)` → unrestricted (admin).
  - else if `sales` on `oemProjects` → inject `{ assignedTo == claims.sub }` into the list filter; on get/update, load the before-state and reject when `assignedTo !== claims.sub`.
  - else if `client` → only the client-portal read paths (see below), never generic CRUD.
- **Client portal is a separate read surface, not generic CRUD.** New actions `clientListProjects` / `clientGetProject` / `clientListDocuments` / `clientGetDocumentUrl` that hard-filter on `customerId == claims.sub` and only return client-visible fields + `visibleToClient` documents. Fail closed to `NOT_FOUND` on any cross-owner id (mirror `getOemFileDownloadUrlAction`).
- **Server-stamped attribution.** Set `createdBy`/`updatedBy`/`updatedAt` server-side on every write; never accept them from the client (keep out of `buildWriteSchema` / mark `readOnly`).
- **Live revalidation (V3).** `revalidateSession` on every authenticated action, so role/scope/suspension changes take effect immediately rather than after 12h.
- **Authenticated storefront catalog (V1).** Add an authenticated variant of `listCatalog`/`getCatalogItem` that verifies role server-side and only then attaches `vipPrice`; the public path stays allowlisted.

## 7. Migration & backfill

- Add columns with safe defaults; backfill `createdBy`/`customerId` best-effort (existing anonymous OEM rows keep `customerId` empty).
- Email encryption is a one-time migration: read plaintext `email` → write `emailEnc` + `emailHashHmac` → drop `email`. Stage behind a feature flag and verify decrypt round-trip before dropping the plaintext column (mirror the image-migration staging pattern already in the codebase).

## 8. Phasing

| Phase | Work | Rationale |
|---|---|---|
| P1 (quick) | V1 pricing allowlist | Unauthenticated leak, ~15 min, zero prerequisites |
| P2 | V2 byte-sniff + `readOnly` mimeType + `nosniff` | Contained; mirrors the proven OEM path |
| P3 | V3 `revalidateSession`; email encryption (§6.3) | Compliance + prerequisite for any scope model |
| P4 | `sales` role + lead `assignedTo` scoping | Enables the sales workflow (§3/§4.5) |
| P5 | `client` role + `customerId` linkage + `documents`/`milestones` + client-portal read actions | Delivers §4.6 (design-first, since PRD marks it phase-1 reserved) |

## 9. Open questions

- Should anonymous OEM submissions be **claimable** by a customer who later registers with the same email (link `customerId` on verified email match)? Recommended, to populate the client portal.
- Key management for §6.3 email encryption: CloudBase env var vs Tencent KMS — confirm the deployment's KMS availability.
- Does a separate storefront/e-commerce spec govern `products`/`overstock` pricing tiers? V1's severity assumes the app's own `PriceBlock` intent; confirm against that spec if it exists.
