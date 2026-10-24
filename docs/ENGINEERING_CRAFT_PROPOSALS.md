# Engineering Craft — Proposals (from the OEM/private-media upload work)

> Candidate lessons distilled from the MIU-08 (OEM Cloud Storage upload + private
> delivery) implementation and its live debugging. **Proposal status — not yet
> merged into `docs/ENGINEERING_CRAFT.md` or the global engineering-craft skill.**
> This is raw material: each section is written so it can be lifted, trimmed, and
> promoted later. One engineer's version from one chat session; expect to merge it
> with parallel write-ups before promotion.

---

## 1. A deployed smoke catches SDK-runtime bugs that unit tests structurally cannot

**Incident.** Every OEM file submission failed in the deployed test env with
`404 NOT_FOUND "Upload not found."` — while 99 admin unit tests, typecheck, lint,
and the local build were all green. The in-memory test adapter (`MemoryAdapter`)
faithfully implements the *intended* semantics of every DB operation, so it can
never reproduce a bug that lives in the *real* SDK's runtime behavior.

**Root cause.** The DB adapter runs on `wx-server-sdk` (the WeChat Cloud SDK).
In the Tencent CloudBase runtime, `add`, `.doc(id).get()`, and **plain**
`.doc(id).update({ data: {...} })` all work — but the **command-based** update
`.doc(id).update({ data: { f: db.command.inc(n) } })` returns `updated: 0` and
**does not apply**. The atomic `inc` operator simply isn't honored. Our
`incrementField` mapped `updated === 0 → null`, callers read `null` as
"row not found", and failed closed.

**Lesson (proposed rule).**
- Any code path whose correctness depends on a *third-party SDK operator* (atomic
  increment, array-union, transactions, conditional writes) MUST be covered by a
  **deployed smoke against the real runtime**, not only by unit tests with a
  test-double. Test-doubles verify *your* logic; they cannot verify the *SDK's*.
- When two SDKs target "the same" backend (here `wx-server-sdk` vs
  `@cloudbase/node-sdk`), treat their command/operator semantics as **separate
  contracts**. Basic CRUD compatibility does **not** imply operator compatibility.
- Prefer the **native SDK for the actual runtime** for anything beyond plain CRUD.
  We routed only the atomic increment through `@cloudbase/node-sdk` (native to
  CloudBase) and left the rest on `wx-server-sdk`.

## 2. A "graceful fallback" can hide a broken primitive for months

**Incident.** The same broken `incrementField` also maintained
`images.publishedRefCount`, which gates public image visibility. It had been
failing identically — but nobody noticed, because catalog delivery has a
**legacy-scan fallback** that serves the image even when the ref-count is
`0`/absent. The fallback masked a broken write primitive; only the OEM path (which
has *no* fallback) surfaced it as a hard failure.

**Lesson (proposed rule).**
- A correctness fallback (legacy scan, cache-miss recompute, "if null then scan")
  is also a **failure mask**. Add an **observability counter/log** on the fallback
  branch so a silently-broken fast path shows up as "fallback rate is 100%".
- When you find a broken shared primitive, **grep every caller** and check whether
  each one fails loudly or silently. The loud caller is the messenger; the silent
  callers are the real blast radius.

## 3. Verify a fix actually resolves the symptom — deploy freshness + re-probe

**Incident.** The first hypothesis was "atomic `inc` on an *absent* field returns
`updated: 0`", so we initialized the counter field to `0`. The fix deployed
cleanly — and the `404` **persisted**. That disproved the hypothesis and pointed
at the real cause (the SDK operator itself).

**Lesson (proposed rule).**
- After deploying a fix, **confirm the new code is actually live** before
  concluding anything. Expose a tiny **`health`/version action that returns the
  build `releaseId`/SHA**, and assert it matches the commit you expect. (Both our
  functions do: `GET /api/health` and `POST /api/admin {"action":"health"}`.)
- Then **re-run the exact failing probe**. "Deployed successfully" ≠ "fixed". A
  green deploy step with a persistent symptom is a *disproof*, and disproof is
  progress — it eliminates a hypothesis.
- Keep the harmless-but-correct part of a wrong fix if it's good hygiene (we kept
  `finalizeClaim: 0`), but **correct the code comments/docs** so the recorded root
  cause is the real one, not the disproven guess.

## 4. Live black-box diagnosis via differential probes

**Technique that worked.** With no DB read access (admin-auth only) we localized
the failure to a single line using **differential probes** against the public
actions (`/api/admin`, no token required for the public OEM actions):

| Probe | Result | What it proves |
| --- | --- | --- |
| valid triad, **no upload** | `404 NOT_FOUND` | not the object read (object never uploaded) |
| **wrong** secret, right ids | `403 FORBIDDEN` | row found + structural checks 1–8 passed |
| **right** secret, no upload | `404 NOT_FOUND` | after the secret check the only 404 path is the claim → pinned to `claim === null` |

**Lesson (proposed rule).** When you can't read internal state, design inputs whose
*different error codes* bisect the code path. Reaching a *later* error (here
`FORBIDDEN`, which is downstream of the row lookup) proves everything *before* it
passed. This is binary search over control flow using observable outputs.

## 5. Browser-direct storage has a CORS/security-domain prerequisite that is invisible in code

**Incident.** After the code was correct, the browser upload/download still failed
cross-origin until the deployed site origin (+ `localhost:4321` for dev) was added
to the storage's **CORS / security-domain** allowlist. On CloudBase the managed
bucket also lives under a **separate console tab** ("云开发桶列表"), so the general
COS bucket list looked empty even though uploads were working.

**Lesson (proposed rule).**
- Browser-direct-to-storage (COS/S3/GCS presigned POST/GET) has a **deploy-time
  ops prerequisite** — bucket CORS `AllowedOrigin/Method/Header` for the site
  origin — that no amount of correct application code satisfies. Capture it as an
  explicit deploy checklist item, and **verify it with a preflight**:
  ```bash
  curl -sI -X OPTIONS 'https://<bucket-host>/' \
    -H 'Origin: https://<site-origin>' -H 'Access-Control-Request-Method: GET'
  # expect: Access-Control-Allow-Origin echoing the site origin
  ```
- Managed-storage buckets are often hidden from the generic storage console.
  Prefer the platform's own storage view (or its API) to confirm existence, not
  the raw provider list.

## 6. Cross-region CI: keep large-file smokes small and configurable

**Incident.** A 9.5 MiB browser upload that took ~16 s locally exceeded **150 s**
from a US GitHub runner → Shanghai storage, so the smoke timed out even though the
code was correct.

**Lesson (proposed rule).**
- A smoke's fixture size should prove the *mechanism*, not the *maximum*. Bytes
  beyond the platform's small-body cap (~100 KiB here) already prove "goes direct
  to storage, not through the function body". Default the CI fixture to a **small
  multiple of the cap** (we use 2 MiB = ~20×) and make it **overridable by env**
  (`E2E_OEM_SMOKE_BYTES`) so the near-cap case can be exercised deliberately.
- Validate the true near-cap round-trip with a **local probe from a low-latency
  location**, and record that evidence — don't push the whole burden onto CI.
- When a browser flow can hang, make the test **race the success signal against
  the on-page error element** and fail fast with the surfaced message, instead of
  waiting out an opaque URL/timeout.

## 7. Client "download" is a contract, not a `window.open`

**Incident (Codex P2).** The admin download did `window.open(tempUrl)`. Because the
temp URL is a raw presigned link with no `Content-Disposition`, browsers
inline-rendered image/PDF drawings, dropped the real filename, and the async popup
could be silently blocked.

**Lesson (proposed rule).**
- To *download* (not view) a private file whose URL carries no disposition header:
  fetch the bytes and save via an object-URL `<a download={fileName}>` — never
  `window.open` after an `await` (popup-blockable, inline-renders, loses the name).
- Extract the orchestration behind a **dependency-injected function**
  (`getUrl`/`fetchBytes`/`saveBlob`) so the filename contract and the failure path
  are **unit-testable without a DOM**, even when the app has no component harness.

## 8. Process guardrails that paid off

- **Serialize with the async reviewer:** `git fetch` + `--ff-only` merge before
  every push, so a reviewer's commits never get clobbered and history stays linear.
- **Bless the reviewed SHA** in a gate file the pre-push hook checks; keep a
  **doc-update guard** so every push touches a tracked ledger/doc.
- **Gate live e2e smokes behind an explicit flag** (`E2E_*_SMOKE=1`) at *both* the
  workflow-input layer and the `test.skip` layer, so they never run in normal CI.
  Never ship an unrunnable smoke "speculatively" without a live-run path.
- **`workflow_dispatch` can target a non-default ref** —
  `gh workflow run <wf> --ref <feature-branch> -f run_x=true` deploys + tests the
  feature branch without touching the shared `test` branch (avoids a redundant
  push-triggered deploy).
- **GitHub Actions config belongs in env-scoped vars/secrets, not YAML.** Confirm
  with `gh variable list --env <env>` / `gh secret list --env <env>`; the workflow
  reads `${{ vars.* }}` / `${{ secrets.* }}` with no hardcoding.
- **Interactive OAuth (e.g. an MCP login) needs a real TTY;** it stalls under a
  non-interactive agent terminal, and the editor's "restart server" command may be
  sandboxed. Hand the login back to a human terminal and continue once creds land.

---

## Suggested placement when promoting

- §1–§4 → engineering-craft category **"third-party integrations / test-double
  divergence"** (the highest-value, most general lessons).
- §5, §6 → **"deploy/ops prerequisites"** and **"CI reliability"**.
- §7 → extends the existing **Private Media Preview Pattern** with a
  **Private Media *Download* Pattern**.
- §8 → **"workflow discipline"**.
