# Security Boundary — Channel Public AI Assistant

**Status:** Proposed; expands §9 of [CHANNEL_AI_ASSISTANT_ARCHITECTURE.md](./CHANNEL_AI_ASSISTANT_ARCHITECTURE.md)
**Scope:** The public website assistant only. Enterprise Brain and the standalone Hermes messaging gateway are out of scope.
**Last reviewed:** 2026-08-11

## 1. The one sentence that matters

An anonymous stranger on the public website can, through the assistant, cause a
retrieval against a company knowledge source. Everything in this document exists
to make sure the only thing that retrieval can ever reach is knowledge a
salesperson would happily read aloud to that stranger.

The highest-consequence control is therefore **a knowledge credential that is
physically incapable of reading internal material** — not one that is trusted not
to, not one filtered after the fact. If that credential is over-scoped, every
other control here is decoration: prompt injection, a model mistake, or an
adapter bug turns directly into disclosure of supplier contracts, internal cost,
or customer projects.

## 2. Trust zones

```text
┌─ UNTRUSTED ────────────────────────────────────────────────────────┐
│ Anonymous browser: visitor input, rendered output, widget code     │
│ Holds: one short-lived conversation credential. Nothing else.      │
└───────────────────────────┬────────────────────────────────────────┘
                            │ HTTPS + SSE, public internet
┌─ EDGE ─────────────────────▼───────────────────────────────────────┐
│ TLS, WAF, CORS, per-IP rate limits, request size caps              │
│ Holds: no business secret.                                         │
└───────────────────────────┬────────────────────────────────────────┘
                            │
┌─ TRUSTED (the only place authorization happens) ───────────────────┐
│ Chat BFF: sessions, control state, leads, PII, sales authorization │
│ Holds: engine credential, database credential, JWT verification    │
│        key, CRM/email credentials.                                 │
└───────────────────────────┬────────────────────────────────────────┘
                            │ private network, authenticated, no public route
┌─ RESTRICTED ───────────────▼───────────────────────────────────────┐
│ Hermes profile (pinned digest, read-only knowledge tools only)     │
│ Holds: model credential, public-knowledge credential.              │
└───────────────────────────┬────────────────────────────────────────┘
                            │
┌─ PUBLIC KNOWLEDGE ─────────▼───────────────────────────────────────┐
│ Dedicated Lexiang public customer-service space                    │
│ Contains: only material approved for public disclosure.            │
└────────────────────────────────────────────────────────────────────┘
```

Two properties define the design: authorization happens in exactly one zone, and
each arrow crosses **downward in privilege only**. The knowledge zone cannot call
back into the BFF; the engine zone has no route to the operational database.

## 3. Credential inventory

Every credential in the system, what it can reach, and what proves it cannot
reach more. No credential ships without its proof row filled in.

| Credential | Held by | Scope it must have | Blast radius if leaked | Proof of isolation |
|---|---|---|---|---|
| Conversation credential | Browser | One conversation, short TTL, no admin surface | Read/continue one anonymous conversation | Test: credential for conversation A rejected on B; expired credential rejected |
| Engine (Hermes) API key | BFF only | Call the restricted profile on a private address | Run the assistant profile; still cannot read internal knowledge | Test: public internet request to the engine address fails to connect |
| Public knowledge token (Lexiang) | Engine profile | **Read** only, **public space** only | Read material already approved for public disclosure | Test: request for a known internal document id returns not-found/denied |
| Model provider key | Engine profile | Approved model endpoint, budget-capped | Model spend | Alert on spend anomaly; monthly cap |
| Operational database credential | BFF and workers | AI operational tables only | Conversations, leads, PII | Test: cannot read CMS/users collections |
| Shared JWT verification key | BFF | Verify sales tokens; never mint public tokens | Impersonation if it is a signing key — prefer verify-only material | Test: BFF cannot issue a token |
| CRM / email credential | BFF workers | Send and create leads | Outbound spam, lead data | Rotation runbook; per-worker scoping |

**Non-negotiable:** none of these except the conversation credential may exist in
browser JavaScript, in a build artifact, in an Astro island prop, in a public API
response, or in a prompt. The build must fail if a secret-shaped string appears
in the site bundle.

## 4. The public-only knowledge space

This is architecture gate 2 and it deserves more than one line.

**What "isolated" has to mean.** A separate Lexiang space, not a folder or tag
inside the internal space. A token issued for that space alone. Read-only. The
isolation must hold at the permission layer, so that a request naming an internal
document id fails for a reason the caller cannot influence.

**Publication is a reviewed act.** Material enters the public space through an
explicit approval by a named owner, with source and review date recorded. Nothing
is synced into it automatically from an internal source, because an automatic
sync is exactly how internal cost data eventually arrives in a public index.

**What must never be in it:** internal cost, margin, supplier identities and
contracts, customer projects and files, unpublished products, negotiated terms,
personnel data, anything under NDA.

**Standing proof.** The negative test in §3 runs in CI against a real internal
document id and must fail closed. A green run proves the boundary today; the test
existing proves it tomorrow.

## 5. Tool surface — the deployment contract

The engine's default tool surface includes terminal, file, browser, and code
execution. On a profile reachable from an anonymous visitor, any one of those is
a remote code execution path with extra steps.

The live `/v1/toolsets` response is the contract:

- **Allow** exactly the approved read-only knowledge tools, asserted by name.
- **Deny**, asserted individually so that a vendor upgrade adding a tool fails the
  test rather than silently arming it: terminal and process execution, file read
  and write, patching, browser control, code execution, delegation to other
  agents, cron and scheduling, memory management, skill management, messaging.
- The assertion is **exact-set**, not "contains". A new tool the test has never
  heard of is a failure by default.

Pin the release and image digest. Never deploy `main` or `latest`. Re-run the
toolset assertion as a deploy gate on every version change, before traffic.

## 6. Untrusted input, including retrieved documents

Visitor text is untrusted. So is every document that comes back from retrieval —
a document is data, never an instruction. The rule that follows is structural:

> Prompt injection cannot grant a capability, because capability is not granted
> by text. The tool surface is fixed at deploy time, the knowledge credential is
> scoped at issue time, and neither reads the conversation.

Concretely: no tool is enabled or selected based on message content; no
credential is chosen by the model; no route, database query, or recipient is
derived from model output. A model that has been fully persuaded by a malicious
document can, at worst, produce bad text — which is then subject to the answer
policy and to §7.

Rendering rules: sanitize Markdown to a strict allowlist, reject raw HTML,
scripts, styles, iframes, and event handlers; render links with an explicit
external indicator and `rel="noopener noreferrer"`; serve with CSP and
`X-Content-Type-Options: nosniff`; treat citation URLs as untrusted (allowlist
schemes, no `javascript:`, no `data:`).

## 7. PII, logging, and retention

- Contact data lives in `leads`, separate from transcript data, collected only
  after an explicit consent action, with the consent text version recorded.
- Default logs carry ids, state, latency, token counts, and error categories.
  Not: full transcripts, prompts, retrieved document bodies, contact fields, or
  raw vendor payloads. `safeDetail` from the engine port is bound by this rule.
- Transcript retention and deletion are approved before launch (gate 4), and
  deletion propagates to derived stores — search indexes, queues, backups within
  their stated window, and the CRM.
- Region and data-processing terms are approved before launch (gates 4 and 5).

## 8. Availability and abuse

- Rate limit at the edge and in the BFF by IP, conversation, and global budget;
  `429` with `Retry-After`.
- Cap message length, turns per conversation, concurrent runs per conversation,
  tokens per run, and total spend per day. Budget exhaustion degrades to the
  inquiry form; it does not degrade into an unmetered assistant.
- Fail closed everywhere: no knowledge, no model, no database, or no budget means
  the assistant declines and shows the human path. A fallback that answers from
  the model's own memory when retrieval fails is forbidden — that is the exact
  path to a confident invented price.

## 9. Route allowlist

The assistant renders only on an explicit allowlist of public routes approved by
the product owner and the security owner (gate 10). It must never appear on
admin, account, authentication, customer-project, or preview routes.

The reason is scoped precisely: on an authenticated page, a widget bug or an
injected script has a session to steal, and a logged-in visitor reasonably
assumes the assistant can see their account. Neither is acceptable, so the
assistant is absent rather than restricted.

Enforcement is a build/route-level test that enumerates rendered routes and
asserts the widget is present on exactly the allowlist and absent everywhere
else — not a runtime conditional that a future refactor can invert.

## 10. Incident response

**If the public knowledge token leaks:** revoke first, rotate second, then audit
retrieval logs for access outside the public space. Because the token is
read-only and space-scoped, the exposure is public material — verify that claim
against the space's actual contents rather than assuming it.

**If the engine credential leaks:** revoke, rotate, confirm the private network
path was never publicly routable, and review run records for the affected window.

**If the operational database credential leaks:** rotate, review access logs,
and treat visitor PII exposure as a notifiable event under the approved
retention and privacy terms.

**Order of operations in every case:** revoke, then rotate, then investigate.
Investigating first leaves the door open while you read the logs.

**If a tool appears in `/v1/toolsets` that is not on the allowlist:** treat as a
production incident. Stop traffic to the profile, do not "review and allow" under
time pressure.

## 11. Non-negotiables

1. No vendor, model, database, or CRM credential in browser JavaScript, build
   output, or a prompt.
2. The engine is not reachable from the public internet.
3. The knowledge credential is read-only and scoped to the public space, proven
   by a standing negative test.
4. The tool surface is asserted as an exact set against the pinned release.
5. Model output never selects a tool, credential, route, query, or recipient.
6. Authorization decisions happen only in the BFF, and sales routes re-read the
   current user row on every request so suspension takes effect immediately.
7. Fail closed. An assistant that cannot ground an answer refuses it.
