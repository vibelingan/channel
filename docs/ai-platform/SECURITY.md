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
│ Holds: one short-lived conversation credential — plus, on this     │
│ origin, the site's own session JWT in localStorage (see §9).       │
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
| Engine (Hermes) API key | BFF **and its workers** | Call the restricted profile on a private address | Run the assistant profile; still cannot read internal knowledge | Test: a request from outside the private network is refused **and** a request from the BFF's network succeeds — a bare "fails to connect" is also what an undeployed engine produces |
| Public knowledge token (Lexiang) | Engine profile | **Read** only, **public space** only, across **every** surface it exposes | Read material already approved for public disclosure | §4 — a three-assertion probe with a positive control, run pre-deploy against the deployed credential |
| Model provider key | Engine profile | Approved model endpoint, budget-capped | Model spend | Test: a request naming a non-approved model is refused; plus spend cap and anomaly alert |
| Operational database credential | BFF and workers | AI operational tables only | Conversations, leads, PII | Test: `SELECT` on a non-AI table is refused, asserted as a permission error — note the CMS lives in NoSQL, so this must be a positive refusal, not an absence of tables |
| **NoSQL `users` read credential** | BFF | Read the current user row for the per-request re-read the architecture requires; **no write** | Read of user records | Test: a write through this credential is refused |
| Shared JWT verification key | BFF | Verify sales tokens | The repo signs with HS256, so the verification material **is** signing material — a holder can mint tokens | Test: the BFF exposes no minting path for AI routes. The stronger fix is asymmetric keys so the BFF holds only a public key; recorded as a follow-up, not a closed control |
| Sales notification credential | BFF workers | Post to the approved sales channel only | Unsolicited messages to the sales channel | Test: posting to a non-approved target is refused; rotation runbook |
| CRM / email credential | BFF workers | Send and create leads | Outbound spam, lead data | Rotation runbook; per-worker scoping; contract test against the sandbox tenant |

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

**Standing proof — and why the obvious version of it is worthless.** The tempting
test is "ask for an internal document id, assert not-found". But *not-found* is
also what a revoked token, an expired token, a typo in the CI config, a wrong
space id, a changed API version, and a moved document all produce. Such a test
goes green the day the credential stops working, and stays green forever.

The probe is therefore three assertions in one run, on **one** credential:

1. **Positive control** — the same token reads a known *public* document
   successfully. Without this the run proves nothing about the token being live.
2. **Explicit denial** — the internal document id returns a permission error.
   A bare not-found is a **failure**, unless the service provably cannot
   distinguish the two, in which case that limitation is recorded.
3. **Write refusal** — attempted against the known-good *public* id, so a
   refusal means "read-only" rather than "target does not exist".

Three further requirements, each of which the naive version misses:

- **Every surface, not just get-by-id.** Retrieval runs through the Lexiang MCP
  tools, and a search or query API can index across spaces and return internal
  titles and snippets while get-by-id is correctly blocked. Enumerate every
  surface the configured knowledge tool exposes — search, query, list spaces,
  list documents, get, attachment download — from the MCP server's own tool
  schema, and assert on **returned content** (a term unique to an internal
  document returns zero hits), not on status codes.
- **The deployed credential, before traffic.** A "production-shaped" token
  checked nightly is not the token serving customers. The probe runs pre-deploy
  against the real credential in the real environment, records that credential's
  fingerprint, and the BFF asserts at startup that the fingerprint matches the
  credential it holds.
- **A sensitivity run.** Once, with a deliberately over-scoped token, the probe
  must go red. A check that has never failed is a check nobody has verified.

The internal document id used by assertion 2 has to be real and current, which
means something in CI must be able to confirm it exists — and that requires a
credential that *can* read the internal space. That credential is not in the §3
inventory and must not be. Resolve it by having the internal-space owner
re-confirm the id on a schedule and fail the probe when the confirmation goes
stale, rather than by handing CI internal read access.

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

Three things stop that assertion from being weaker than it looks:

- **Scope it to the profile that actually serves runs.** A toolsets listing may
  describe the *server's* configuration while runs execute under the profile id
  the adapter sends. Parameterize the assertion by that exact profile id and
  require the response to echo it back, or the test may be reading the wrong
  subject forever.
- **A listing proves a tool is unlisted, not that it is undispatchable.** In most
  agent servers, listing and dispatch are separate code paths. Add one positive
  probe that *invokes* a denied tool through the production profile and asserts
  refusal.
- **MCP servers are a second tool surface.** Knowledge retrieval arrives through
  MCP, and adding an MCP server arms new tools without changing the image
  version. Assert the exact set of configured MCP servers and the tools each
  exposes as part of the same gate.

Pin the release and image digest. Never deploy `main` or `latest`. Bind the gate
to a hash of **image digest + profile configuration + MCP server list**, and
re-run it before traffic whenever that hash changes — not merely on a version
change, which an MCP config edit is not.

## 6. Untrusted input, including retrieved documents

Visitor text is untrusted. So is every document that comes back from retrieval —
a document is data, never an instruction. The rule that follows is structural:

> Prompt injection cannot grant a capability, because capability is not granted
> by text. The tool surface is fixed at deploy time, the knowledge credential is
> scoped at issue time, and neither reads the conversation.

Concretely: no tool is enabled or selected based on message content; no
credential is chosen by the model; no database query or recipient is derived from
model output. Lead creation and the request for a human both originate from the
visitor's own actions, never from an engine event — that is closed by
construction, since the engine's event types carry no side effect.

The one place engine output does reach a navigable surface is a **citation
URL**, which becomes an `href` the visitor can click. Treat it as untrusted:
allowlist schemes, reject `javascript:` and `data:`, and mark it external.

Keeping this true over time needs an enumeration, not a habit: a test that walks
the event-handler dispatch table and asserts every outbound effect reachable from
an engine event — database write, outbox row, notification, HTTP call — is on an
approved list. A future event variant that carries a side effect then fails the
build instead of shipping.

A model that has been fully persuaded by a malicious document can, at worst,
produce bad text — which is then subject to the answer policy and to §7.

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
- Visitor messages themselves may contain contact details ("call me on …"), so
  the separation above is a rule about where the *lead* record lives, not a
  guarantee that the transcript is PII-free. A redaction step on the write path
  is required for the turns sent to the engine; without it, LLD-002's claim that
  turns carry no contact fields is aspirational.
- **Deletion is tombstoning, not row removal.** The event log's sequence must
  stay gapless (LLD-001 I1), and a gap is an integrity alarm — so deleting rows
  to honour a data-subject request would either leave the PII or trip the alarm.
  Replace the payload in place, keep the sequence, and let the dispatcher render
  a tombstone. The test asserts all three: content gone, I1 intact, tombstone
  rendered.
- Transcript retention and deletion are approved before launch (gate 4), and
  deletion propagates to every derived store — the existing NoSQL leads and OEM
  inquiries, media storage, search indexes, queues, the CRM, and backups within
  their stated window. Enumerate them as a checklist with one assertion each;
  "propagates to derived stores" without a list is unfalsifiable.
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
- **"Absent" must fail as hard as "unreachable."** A credential missing from the
  environment is the more likely failure and the easier one to get wrong. This
  codebase already has the wrong pattern in production: the public catalog API
  treats a missing `JWT_SECRET` as optional and falls back to an anonymous
  viewer, commented as the safe default. Applied to a knowledge credential, that
  same shape yields an assistant with no retrieval that answers anyway. Require
  the credential at startup and refuse to serve without it.
- Restore ADR-001's operational control that makes this visible: **every
  third-party integration reports a safe `LIVE` or `DISABLED` status at startup
  and feeds readiness.** A `DISABLED` knowledge source means readiness is red and
  the widget shows the inquiry path — not a quiet degradation nobody notices.
- The engine's own CORS configuration is empty or BFF-origin only. A private
  address with permissive CORS becomes exploitable the day a load balancer is put
  in front of it.
- A worker being down entirely must surface as a terminal run event, not as an
  SSE stream that stays open forever while the visitor waits.

## 9. Route allowlist

The assistant renders only on an explicit allowlist of public routes approved by
the product owner and the security owner (gate 10). It must never appear on
admin, account, authentication, customer-project, or preview routes.

**Be precise about what this does and does not buy, in this codebase.** The
site's session token is a JWT held in `localStorage` under `channel.token`, and
`localStorage` is scoped to the *origin*, not the page. The public
`/headphones` storefront already reads that token to request VIP pricing — and
`/headphones` is exactly the kind of route the allowlist will contain, since it
is where MOQ, price, and product questions get asked.

So the honest statement is: keeping the assistant off `/admin` does **not**
protect the session, because the session is not confined to `/admin`. A
Markdown-sanitizer escape on an allowlisted public page reaches the same token.
The allowlist is defence in depth plus a product boundary — a logged-in visitor
on their account page reasonably assumes the assistant can see their account, and
it cannot — but it is not the control that protects the credential.

The controls that would actually confine the token are an `httpOnly`,
`SameSite` cookie, or rendering the assistant inside a sandboxed cross-origin
iframe. Until one of them exists, gate 10 must not be recorded as closing the
session-theft risk, and the risk sits on the sanitizer and CSP instead. The
missing test is an end-to-end one that seeds `channel.token`, drives a hostile
Markdown payload through the assistant on an allowlisted route, and asserts the
token never leaves the page.

Enforcement of the allowlist itself is a build/route-level test that enumerates
rendered routes and asserts the widget is present on exactly the allowlist and
absent everywhere else — not a runtime conditional that a future refactor can
invert. In this repo `/admin` is a single Astro route mounting a client-only
React application that shares `BaseLayout` with every public page, so the widget
must be mounted **per page**, never in a shared layout with a conditional.

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
5. Model output never selects a tool, credential, database query, or recipient,
   and never triggers a side effect. The single navigable surface it influences
   is a citation URL, which is scheme-allowlisted and rendered as external.
6. Authorization decisions happen only in the BFF, and sales routes re-read the
   current user row on every request so suspension takes effect immediately.
7. Fail closed. An assistant that cannot ground an answer refuses it.
