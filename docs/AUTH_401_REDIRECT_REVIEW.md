# Admin 401 / Expired-Session Redirect — Pre-Push Review

Status: **APPROVE WITH SUGGESTIONS** — 0 P1, 2 P2, 4 P3. No blockers; the two P2
items are robustness/maintainability follow-ups, not merge gates.

Reviewer: GitHub Copilot (dev-pipeline `review` flow, VS Code adaptation).
Date: 2026-07-02.

## Scope

| Field | Value |
| --- | --- |
| Branch | `dev/SeanCai/401-login-redirect` |
| Commit under review | `b563b94` — "Handle expired admin sessions" |
| Base (fork point) | `2badb7c` on `dev/albertli/try01` |
| Diff | 4 files, +212 / −24 |

Files:

- `apps/site/src/islands/admin/AdminApp.tsx` — gate state machine + server-side session verification.
- `apps/site/src/islands/admin/api.ts` — tolerant envelope parsing + `fetchCurrentUser()`.
- `apps/site/src/lib/session.ts` — tolerant envelope parsing in `callApi`.
- `tests/e2e/admin-session.spec.ts` — new Playwright coverage (2 tests).

> Review method note: this branch was reviewed in an **isolated `git worktree`**
> (`../channel-wt-401review`) so the primary checkout stayed on `dev/albertli/try01`
> for a concurrent session. Findings were derived from `git diff 2badb7c..b563b94`
> plus cross-file verification against the branch's own backend/shared sources
> (grep/read), not from the main workspace tree — which is checked out to a
> different branch and would have mis-reviewed the code.

## What the change does

Fixes the bug where an **expired admin token surfaced as a "Request failed (401)"
table error** instead of bouncing the user to `/login`. Root cause: `call()` /
`callApi()` short-circuited on `!res.ok` and threw `INTERNAL_ERROR` for a 401,
so the `error.isUnauthorized` redirect path never matched.

Changes:

1. **Envelope-aware error mapping** — `call()` (api.ts) and `callApi()` (session.ts)
   now read the response body via `readApiEnvelope()`; a 401 (or an unparseable/empty
   body with HTTP 401) maps to code `UNAUTHORIZED`, which drives the redirect.
2. **Server-authoritative admin gate** — `AdminApp` no longer trusts the cached
   `localStorage` user. It calls the new `fetchCurrentUser()` → `call('me')` and
   gates on the server's role before mounting the dashboard. Introduces a
   `GateState = 'checking' | 'authorized' | 'denied' | 'error'` machine.
3. **Mutation errors also redirect** — subscribes to `getMutationCache()` in addition
   to `getQueryCache()`, so a 401 from a save/mutation now redirects too.
4. **`redirectToLogin()`** centralizes `clearSession()` + `queryClient.clear()` + `gotoLogin()`.
5. New E2E spec asserting stale-token → `/login?returnTo=/admin` and login-401 stays inline.

## Verification performed (cross-file seams)

| Seam | Result | Evidence |
| --- | --- | --- |
| Does backend implement `'me'`? | ✅ exists, auth-gated | `apps/functions/admin/src/handler.ts:323` (`case 'me'`), dispatched **after** `authenticate()` → invalid token returns `UNAUTHORIZED` (`:320`) |
| `me` return shape == `{ user: SessionUser }`? | ✅ | `handler.ts:740` → `ok({ user: publicUser(user) })` |
| Dev parity (local-server) | ✅ no gap | `apps/local-server/src/main.ts:11,77` reuses `handleAdminRequest` — `'me'` works offline too |
| `SessionUser` shape | ✅ `{ id, email, username, role }` | `packages/shared/src/auth.ts:50` |
| `session.ts` exports consumed by AdminApp | ✅ `getToken`/`setSession`/`clearSession` | `session.ts:61,77,83` |
| react-query cache-subscribe APIs | ✅ valid in v5 | `@tanstack/react-query ^5.62.7`; `event.mutation?.state.error` optional-chained |
| `canAccessAdmin` import | ✅ re-exported from shared | `session.ts:15` ← `packages/shared/src/auth.ts:21` |

Happy / expired / denied paths were traced end-to-end and are correct. **No P1 found.**

## Findings

| # | Sev | File:Line | Lens | Issue | Proposed fix |
| --- | --- | --- | --- | --- | --- |
| 1 | P2 | api.ts:~34–62 & session.ts:~37–60 | cross-file / DRY | `ApiEnvelope`, `ApiError`, `isRecord`, `isApiEnvelope`, `readApiEnvelope` are duplicated **verbatim** in two files, and reinvent the canonical `ApiResult<T>` + `isOk()` already in `packages/shared/src/api.ts:21,42`. Two copies will drift. | Extract one `readApiEnvelope`/guard into shared (or a single site lib), typed on the existing `ApiResult<T>`. Delete the duplicate. |
| 2 | P2 | AdminApp.tsx (gate `.catch`) + handler.ts:741 | deep / edge case | A **valid token for a deleted account** → `me` returns `NOT_FOUND`, which is not `isUnauthorized`, so the UI sticks on the `'error'` "Session check failed" screen whose only action reloads → same error forever. User can never reach `/login`. | Treat `NOT_FOUND` (and other terminal session-invalid codes) on `me` as session invalidation → `redirectToLogin()`. |
| 3 | P3 | AdminApp.tsx (`gate === 'checking'` → `return null`) | deep / UX | Every admin mount now blocks on the `me` round-trip and renders **blank white** meanwhile (previous gate was synchronous). | Render a lightweight loading/spinner state for `'checking'` instead of `null`. |
| 4 | P3 | AdminApp.tsx (`redirectToLogin` from both cache sub + guard catch) | deep | On a 401 the redirect can fire twice (guard `.catch` and cache subscription). Idempotent today (`clearSession`/`queryClient.clear`/`location.href` are safe to repeat), so benign. | Optional: guard with a `redirecting` ref to avoid double work. |
| 5 | P3 | api.ts:~35 (`interface ApiError`) | typescript | Local `ApiError` duplicates `session.ts`'s exported `ApiError` and shared's `ApiErr`; three near-identical shapes. `isApiEnvelope<T>` also cannot validate `data` as `T` (unavoidable) — the `data` cast is unchecked. | Consolidate on the shared type (folds into #1). |
| 6 | P3 | tests/e2e/admin-session.spec.ts | test | Covers the two headline paths well, but no case for the `'error'` (non-401) branch, the `'denied'` role branch, or the P2 `NOT_FOUND` edge. Stale-user fixture carries `status: 'active'`, which isn't on `SessionUser` (harmless). | Add a `'denied'`-role case and, once #2 is fixed, a `NOT_FOUND`→redirect case. |

## By reviewer lens

- **Assumption-checker — PASS.** No URL-topology drift (still POSTs the single admin
  portal via `apiUrl`), no new env vars, no multi-tenancy change. The `me`-based gate
  is consistent with the existing server-authoritative session model.
- **Cross-file — PASS (see #1).** All consumer↔producer seams verified above; the only
  smell is the duplicated/ reinvented envelope helpers.
- **Deep — see #2/#3/#4.** Core state machine is correct; the notable gap is the
  deleted-account `NOT_FOUND` stuck-state (#2).
- **TypeScript — PASS.** No `as any` / `@ts-ignore`; clean type guards. Minor type
  duplication (#5). (Note: `tsc` was not executed in the isolated worktree — no
  `node_modules`; recommend the branch's own `pnpm typecheck` in CI/local remains green.)
- **Security — PASS / net improvement.** The gate now verifies the token server-side and
  uses the server's authoritative role instead of trusting `localStorage`; `clearSession()`
  + `queryClient.clear()` on unauthorized prevents stale cached admin data leaking across
  sessions. No secrets, injection sinks, or new env surfaces. (Token-in-`localStorage`
  XSS exposure is pre-existing and out of scope for this diff.)
- **Test — PASS.** Behavior-accurate Playwright coverage of the two primary paths;
  extension suggestions in #6.

## Gate decision

Per the dev-pipeline gate (0 P1, ≤3 P2 → proceed with ACK): **not blocked.**
Recommend addressing **#2 (deleted-account stuck state)** before or right after merge,
and **#1 (de-duplicate the envelope helper)** as a small follow-up. #3–#6 are nits.

## Follow-up Applied

2026-07-03: Valid review findings were addressed on `dev/SeanCai/401-login-redirect`:

- #1/#5: extracted shared site-side response-envelope parsing into `apps/site/src/lib/api-envelope.ts` and reused it from both admin and session clients.
- #2: `NOT_FOUND` from the `me` session preflight now invalidates the stale session and redirects to `/login?returnTo=/admin`.
- #3: the admin gate now renders a lightweight `Verifying session...` state instead of a blank screen.
- #4: login redirects are guarded with a ref so query/mutation/preflight failures cannot trigger duplicate redirect work.
- #6: E2E coverage now includes valid-admin happy path and deleted-account `NOT_FOUND` redirect coverage.
