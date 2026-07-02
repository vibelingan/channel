# Operations And Review

Upload work usually fails at the boundary between correct code and real
infrastructure. Treat the following as part of the feature, not aftercare.

## Shared Branch Discipline

- Use the repository's intended Git transport. If the project/user requires SSH,
  keep fetch and push on `git@github.com:...`; do not silently fall back to
  HTTPS.
- Before committing on a shared branch, fetch the live remote head and fast
  forward or rebase without force pushing.
- Stage only the files in scope. Leave unrelated untracked/generated output
  alone.
- If multiple agents review/implement on the same ordinary branch and there is
  no PR, keep a lightweight ledger in docs and reference the reviewed commit SHA.

## Secrets And CI Credentials

- Never route live cloud credentials through chat transcripts or docs.
- Prefer direct secret-setting flows for CI, such as GitHub environment secrets.
- For CloudBase CI, permanent scoped CAM keys are durable; temporary STS tokens
  expire and can make a previously green deployment fail later. Delete stale
  session-token secrets when switching to permanent credentials.
- Keep configuration in environment-scoped variables/secrets, not hardcoded YAML.

## CI And Deployment Evidence

- Use deterministic, scriptable provider tooling for CI/CD. For CloudBase
  function code in this repo, that is CloudBase CLI primary; MCP remains useful
  for IDE/resource management and diagnostics.
- Dispatch live smokes explicitly, and target the feature ref when the workflow
  supports it.
- Record the deployed release SHA from a health endpoint before interpreting a
  live result.
- After a deploy, rerun the exact failing probe. A green deploy with the same
  symptom disproves the hypothesis rather than proving the fix.

## Smoke Design

- Unit tests with fake adapters prove app logic; they do not prove third-party
  SDK runtime semantics.
- Add a deployed smoke for provider operators such as atomic increment,
  conditional writes, transactions, and signed upload/download credentials.
- Large cross-region uploads can make CI flaky. Default to a fixture that proves
  the byte path bypasses the API body cap, and make near-cap fixtures
  env-overridable or locally probed from a low-latency location.
- Race browser success signals against visible error text so failures surface
  quickly instead of becoming opaque timeouts.

## Diagnosis Patterns

- When internal state is unavailable, design differential probes that move the
  request to distinct error codes. Reaching a later error proves earlier guards
  passed.
- Treat graceful fallbacks as failure masks. Add counters/logs to fallback
  branches so broken fast paths become observable.
- When one shared primitive fails, grep every caller and check which paths fail
  loudly versus silently.

## Monitoring Hygiene

- Background monitors are useful only while they create actionable work.
- No-op scheduled messages should be silent or disabled; repeated chat wakeups
  inflate context and make the actual review harder to follow.
- If the user wants review findings visible in chat, run the review in the chat
  and keep background automation limited to notification or health checks.
