# Review Checklist

Use this checklist for design reviews, implementation reviews, and final
acceptance.

## P0/P1 Blockers

- New product/OEM/business uploads still send bytes through JSON/base64.
- The route body cap, storage CORS, auth model, or provider credential shape is
  assumed instead of measured.
- Hand-written TypeScript declarations claim provider methods that the installed
  runtime package does not expose.
- Browser clients can choose durable storage paths, storage provider fields, or
  lifecycle status.
- Public upload intent creation has no rate limit, pending cap, TTL, or cleanup.
- Finalization can run concurrently and repeatedly download/delete/mutate for
  one upload intent.
- Private files are exposed through public delivery routes or durable raw
  storage URLs.
- Delete/cleanup code ignores per-object failures.
- Deployed evidence does not run the real runtime code path.
- The implementation depends on a third-party SDK operator but has no deployed
  smoke against the real SDK/runtime.
- CI credentials are temporary, expired, or routed through chat instead of
  environment secrets.

## P2 Risks

- Smoke tests pass only after retry without preserving the failing network/app
  state.
- Deployed smoke uses a tiny fixture while the exit criterion claims near-cap
  coverage.
- Admin download tests mint a URL but never exercise browser Blob download/CORS.
- Legacy base64 compatibility remains reachable by new non-legacy callers.
- Temporary signed URLs are stored in DB rows.
- Cleanup is implemented in unit tests but not wired into a production action,
  timer, or piggyback path.
- The design mentions provider features that the selected SDK cannot express.
- Bucket CORS/security-domain setup is documented but not verified from the
  deployed browser origin.
- Fallback branches hide broken fast paths without logging/counters.
- The admin UI can mint a private URL but does not exercise the final Blob
  download path and filename contract.
- Shared-branch review relies on background monitors only, with no visible
  review findings or reviewed SHA ledger.

## Evidence To Record

- Infrastructure limits and exact deployed route body cap.
- Provider SDK versions and contract probes.
- Upload policy table by purpose/type/size.
- Intent, upload, finalize, cleanup, and delivery sequence.
- Local checks: typecheck, unit tests, provider contract gate, package smoke.
- Deployed checks: release SHA, health endpoint, browser upload, CORS, admin
  private download, failure/oversize behavior.
- Known caveats, retry/flakiness, and remaining MIUs.
- Git transport and branch coordination assumptions when multiple agents share
  an ordinary branch.
- Secret-management path for CI credentials, including removal of stale session
  tokens when switching to permanent keys.

## Common Fix Patterns

- Replace generic upload actions with purpose-specific policy helpers.
- Move byte transport to storage and keep JSON for metadata only.
- Inject the exact provider SDK object needed for storage metadata instead of
  widening another SDK type.
- Add an executable SDK contract gate to CI.
- Use `Blob` object URLs for private browser preview/download, then revoke them.
- Add bounded expired-pending cleanup before declaring a public upload surface
  merge-ready.
- Route provider atomic operators through the SDK proven in the deployed
  runtime, not merely the SDK that compiles locally.
- Add a health/release endpoint and rerun the exact failing probe after deploy.
