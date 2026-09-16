# LLD-002: The `ConversationEngine` Port

**Status:** Proposed; specifies the boundary named in [CHANNEL_AI_ASSISTANT_ARCHITECTURE.md](./CHANNEL_AI_ASSISTANT_ARCHITECTURE.md) §1
**Owning architecture:** Channel public AI assistant
**Depends on:** [ADR-001](./ADR-001-HERMES-LEXIANG-CONTROL-PLANE.md) (Anti-Corruption Layer decision)
**Last reviewed:** 2026-08-11

## 1. Why this shape must be pinned first

The architecture promises that Hermes can be replaced by direct Lexiang Q&A,
Tencent ADP, or a CloudBase Agent through a later ADR. That promise is only real
if the interface is written before the Hermes adapter. Written after, the
adapter's assumptions leak into it — a Hermes run id in the type, a Hermes error
string in a branch, a Hermes tool name in a config field — and the boundary
becomes a Hermes-shaped hole that only Hermes fits.

Plain statement: this file defines what the assistant's brain must be able to do,
in words that do not name a vendor.

What this port does **not** do is lower the bar for swapping one. The
architecture requires a later ADR plus equivalent security, cancellation,
evaluation, and operations evidence before any replacement ships. Passing the
conformance suite is necessary and nowhere near sufficient — it proves the new
adapter fits the socket, not that the vendor behind it is fit to answer
customers.

## 2. What the port owns and what it must never own

| The port owns | The port must never own |
|---|---|
| Turning a request into a vendor call | Conversation state, control version, sequences |
| Streaming vendor output as normalized events | Any database access whatsoever |
| Normalizing vendor errors into a closed category set | Deciding whether to retry a business operation |
| Transport-level retry, timeout, and backpressure | Deciding whether to refuse an answer |
| Declaring what the vendor can and cannot guarantee | Holding request-scoped visitor identity or PII |
| Holding vendor credentials, never exposing them | Writing to the HTTP response |

The last row on each side is the one that gets violated first. If an adapter ever
receives a `Response` object or a database handle, the boundary is gone.

## 3. Placement

```text
packages/ai-engine/            # the port, types, and conformance suite — no vendor code
  src/port.ts                  # ConversationEngine, request/response/event types
  src/errors.ts                # EngineErrorCategory and the mapping rules
  src/capabilities.ts          # EngineCapabilities descriptor
  src/conformance.ts           # the suite every adapter must pass
  src/fake-engine.ts           # deterministic in-memory adapter for BFF tests

packages/ai-engine-hermes/     # the first adapter — the only place "Hermes" appears
  src/hermes-engine.ts
  src/hermes-engine.test.ts    # runs the shared conformance suite
```

Separate packages, not folders. A dependency-direction test asserts that
`packages/ai-engine` imports nothing from any adapter, and that the BFF imports
the port but never an adapter type. This mirrors how `packages/db` keeps its
CloudBase adapter behind `DbAdapter`.

## 4. The port

```ts
export interface ConversationEngine {
  /** Static description of what this engine guarantees. Read at startup. */
  readonly capabilities: EngineCapabilities;

  /**
   * Create a run. MUST be replay-safe with respect to `operationId` when
   * `capabilities.supportsIdempotentCreate` is true: calling twice with the
   * same operationId yields one run and the same handle.
   */
  createRun(request: EngineRunRequest, signal: AbortSignal): Promise<EngineRunHandle>;

  /**
   * Stream normalized events for a run. The caller commits each event to the
   * ordered log before it becomes visible; the engine never writes to a
   * response. Must terminate on `signal` abort.
   */
  streamRun(handle: EngineRunHandle, signal: AbortSignal): AsyncIterable<EngineEvent>;

  /** Idempotent. An unknown or already-finished run is success, not an error. */
  cancelRun(handle: EngineRunHandle): Promise<EngineCancelResult>;

  /**
   * Resolve a handle from an operationId alone — needed to reconcile a run
   * created just before a crash. Present only when
   * `capabilities.supportsRunLookupByOperationId` is true.
   */
  findRunByOperationId?(operationId: string): Promise<EngineRunHandle | null>;

  /** Safe status for readiness. Never returns credentials, hosts, or paths. */
  health(): Promise<EngineHealth>;

  /**
   * Non-secret attestation of the knowledge credential this engine is actually
   * configured with. SECURITY.md §4 requires the BFF to confirm at startup that
   * the credential which passed the pre-deploy scope probe is the one now
   * serving traffic — and the BFF cannot inspect that credential itself,
   * because it does not hold it and must not.
   *
   * The holder attests instead. This carries NO secret material: an opaque
   * stable identity plus a rotation counter, both safe to log.
   */
  attestKnowledgeCredential(): Promise<KnowledgeAttestation>;
}
```

`createRun` and `streamRun` are separate on purpose. LLD-001 §5 must record the
vendor run id and then authorize the run under a version check *between* the two,
and a single `create-and-stream` call would leave nowhere to put either write.

## 5. Types

```ts
export interface EngineRunRequest {
  /** Stable id for replay-safe creation. Derived from the run row; see LLD-001 §3. */
  operationId: string;
  /** Opaque correlation id for logs and vendor metadata. Never the visitor's id. */
  conversationRef: string;
  /** Ordered turns. Content only — no visitor identity, no contact fields. */
  turns: EngineTurn[];
  /** Named, versioned server-side profile. Never raw prompt text from a client. */
  profileId: string;
  locale: string;
  limits: {
    maxDeliveredOutputUnits: number;
    maxStreamDurationMs: number;
    maxToolCalls: number;
  };
}

export interface EngineTurn {
  /**
   * No 'human' role, deliberately. `conversationMessages` stores visitor,
   * assistant AND human-agent messages, but whether a returned-to-AI
   * conversation replays the salesperson's turns — and under what redaction
   * rule — is LLD-001 open question 3. Human turns routinely contain contact
   * details the visitor gave a person, so replaying them unredacted would
   * cross the PII boundary this file draws below.
   *
   * Until that question is answered, human turns are excluded and the model
   * sees a gap. Adding the role later is additive; adding it now would decide
   * a privacy question by accident.
   */
  role: 'visitor' | 'assistant';
  text: string;
}

export interface EngineRunHandle {
  operationId: string;
  /** Vendor run id, opaque to every caller. Never leaves the BFF. */
  engineRunId: string;
}

export type EngineEvent =
  | { type: 'token';    text: string }
  | { type: 'citation'; citation: EngineCitation }
  | { type: 'final';    text: string; citations: EngineCitation[]; usage?: EngineUsage }
  | { type: 'error';    category: EngineErrorCategory; retriable: boolean; safeDetail?: string };

export interface KnowledgeAttestation {
  /** Stable, opaque identity of the credential — a hash or key id, never the key. */
  credentialId: string;
  /** Increments on rotation, so a silent swap is detectable. */
  rotationCounter: number;
  /** The knowledge space the credential is scoped to, by its public identifier. */
  spaceId: string;
}

export interface EngineCitation {
  /** Stable id in the knowledge space. Not a vendor-internal document handle. */
  sourceId: string;
  title: string;
  url?: string;
  snippet?: string;
  retrievedAt: string; // ISO 8601
}

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
}

export type EngineCancelResult = 'stopped' | 'already_finished' | 'unknown_run';
```

Deliberate omissions, each of which would break the boundary if added: vendor
session ids, raw vendor payloads, tool names, model ids in the request (the
profile pins the model server-side), system prompt text, and anything
PII-shaped. A visitor's name and email travel to the lead store, never to a run.

## 6. Error taxonomy

Adapters map every vendor failure into this closed set. The BFF branches on the
category and never on a vendor message.

| Category | Meaning | BFF behaviour |
|---|---|---|
| `transient` | Network blip, 5xx, stream reset | Adapter already retried its transport; BFF fails the run and offers retry |
| `timeout` | Exceeded `maxStreamDurationMs` | Fail the run; visitor sees a retry affordance |
| `quota` | Budget or rate ceiling at the vendor | Fail closed; degrade to inquiry form; alert |
| `unavailable` | Engine or knowledge source down | Fail closed; degrade to inquiry form; readiness turns red |
| `invalid_request` | The BFF built a bad request | Fail the run; alert — this is a bug, not a visitor problem |
| `content_filtered` | Vendor refused to produce output | Present the standard refusal and the human path |
| `knowledge_empty` | No grounding evidence found | Refuse and offer inquiry or human help, per answer policy |

`safeDetail` is a short, non-sensitive string for operators. Vendor stack traces,
prompts, credentials, hostnames, and retrieved document bodies must not appear in
it — the log rules in [SECURITY.md](./SECURITY.md) §7 apply to it verbatim.

## 7. Capabilities — making unproven gates visible in code

```ts
export interface EngineCapabilities {
  engineId: string;          // 'hermes'
  engineVersion: string;     // pinned release
  imageDigest?: string;      // recorded on every run row for audit
  supportsIdempotentCreate: boolean;
  supportsRunLookupByOperationId: boolean;
  /**
   * The worker that OWNS an in-flight run can cancel it. For an
   * OpenAI-compatible engine this is satisfied by aborting the HTTP
   * connection; the port's AbortSignal is that mechanism.
   */
  supportsStop: boolean;
  /**
   * A run can be stopped by a process that does NOT hold its connection —
   * e.g. Hermes' `/v1/runs/:id/stop`. **No OpenAI-compatible chat-completions
   * API has this**, because cancellation there means closing the connection.
   * Non-blocking: see ADR-002 §3 for why, and what it costs when false.
   */
  supportsOutOfBandStop: boolean;
  supportsCitations: boolean;
}
```

This descriptor is the mechanism that stops an unproven assumption from becoming
a silent one. At startup the BFF refuses to serve if:

- `supportsStop` is false — the owner being unable to cancel its own run is not
  survivable: a visitor pressing Stop would be ignored entirely;
- `supportsIdempotentCreate` is false **and** the operation-id mapping layer of
  LLD-001 §7 is not configured;
- `supportsRunLookupByOperationId` is false **and** no other route exists to stop
  a run whose id was never recorded — without this check a legal, startup-
  approved configuration exists in which an orphaned run can never be found or
  stopped, burning tokens against a single engine instance;
- `supportsCitations` is false while the active answer policy requires citations;
- the knowledge source is not configured at all. **Absent is not the same as
  unreachable**, and this codebase has precedent for the wrong behaviour: the
  public catalog API treats a missing `JWT_SECRET` as "anonymous viewer" and
  serves on. Applied here, a missing knowledge credential would produce an
  assistant with no retrieval that answers from the model's own memory — the one
  outcome SECURITY.md forbids outright.

Refusing at startup rather than at the first visitor is the point. Gate 7 of the
architecture stops being a line in a checklist and becomes a boolean the process
reads before it opens a port.

### 7.1 Two kinds of cancellation, and why the distinction is load-bearing

LLD-001's cancel worker stops a run that a *different* worker is streaming. That
requires an out-of-band stop endpoint. Hermes' Runs API has one; **no
OpenAI-compatible chat-completions API does**, because in that protocol
cancellation *is* closing the connection, which only the connection's owner can
do. Verified by aborting a live stream (ADR-002 §3).

So the single `supportsStop` flag conflated two different guarantees:

| Capability | Meaning | Blocking? |
|---|---|---|
| `supportsStop` | The owning worker can cancel its own in-flight run | **Yes.** Without it the visitor's Stop button does nothing |
| `supportsOutOfBandStop` | Another process can stop a run it does not own | **No.** When false, the owning worker polls `cancel_requested_at` between events and aborts itself |

**What it costs when `supportsOutOfBandStop` is false.** Nothing on
correctness: LLD-001 §4.2's fence means no assistant text is ever *committed*
after a takeover regardless of what the model is doing. The cost is bounded
waste — a run whose owner has died keeps generating until the vendor finishes it
or its own limits stop it. The bound is `EngineCapabilities.vendorMaxOutputTokens` — the
engine's OWN ceiling, which is the only limit the vendor honours. It is NOT
`maxDeliveredOutputUnits`, which bounds only what this process receives and
therefore says nothing about what a vendor keeps generating after we stop
listening. See the output-limits section below.
and that figure belongs in the budget model (MIU 14b).

## 8. Rules that keep the boundary real

1. **One vendor per adapter package.** The string `hermes` appears in exactly one
   package. A grep test enforces it.
2. **No database, no HTTP response, no clock-based business logic** inside an
   adapter. Injected clock only.
3. **Transport retry belongs to the adapter; business retry belongs to the BFF.**
   An adapter may retry a failed socket. It may never re-create a run — that
   would duplicate work the fence is counting.
4. **Configuration through the external configuration store; secrets through the
   secret manager.** An adapter reads its own credentials and exposes none.
5. **Tool policy is the adapter's problem to enforce and the BFF's to verify.**
   The adapter configures the restricted profile; a contract test asserts the
   live tool surface (SECURITY.md §5). The port itself has no "tools" concept —
   which is exactly why a future direct-knowledge adapter fits without change.
6. **Every run row records `engineId`, `engineVersion`, and `imageDigest`** so an
   incident can be scoped to a runtime version without guessing.
7. **The fake adapter is a first-class artifact.** BFF integration tests run
   against `fake-engine.ts` with real PostgreSQL, so state-machine tests are
   deterministic and need no vendor.

## 9. Conformance suite

Every adapter — including the fake — must pass one shared suite. An adapter that
cannot pass it is not swappable, whatever its README claims.

| Case | Asserts |
|---|---|
| Replayed `createRun` with one `operationId` | One vendor run; identical handle. **When `supportsIdempotentCreate` is false this case becomes mandatory, not skipped** — it runs against the composed stack (mapping layer + adapter) and adds a crash-between-call-and-record variant. Skipping it there would disable the only test of the hand-built replacement, in exactly the configuration that has no vendor guarantee behind it |
| `cancelRun` twice | Both succeed; second returns `already_finished` or `stopped` |
| `cancelRun` from a process that does not hold the stream | Only asserted when `supportsOutOfBandStop` is true. When false, the suite instead asserts that aborting the owning signal terminates the run, and that `cancelRun` reports honestly rather than pretending to have stopped something it cannot reach |
| `cancelRun` on an unknown id | `unknown_run`, not a thrown error |
| Abort the signal mid-stream | Iterator terminates promptly; no further events |
| Vendor 500 / socket reset / malformed frame | Surfaces as `error` with the right category; never throws raw vendor objects |
| Exceeding `maxDeliveredOutputUnits` / `maxStreamDurationMs` | Stream ends; run is failed with `timeout` |
| Every event | Matches the schema exactly; unknown vendor fields are dropped, not passed through |
| `health()` output | Contains no credential, host, or path |
| `attestKnowledgeCredential()` | Returns a stable id and space id, contains no secret material, and changes its rotation counter when the credential is rotated |
| Package boundary | Port package imports no adapter; BFF imports no adapter type |

## 10. Open questions this design does not settle

1. Whether the pinned Hermes release satisfies `supportsIdempotentCreate` and
   `supportsRunLookupByOperationId` (architecture gate 7).
2. Whether Lexiang returns a stable `sourceId` suitable for citation identity
   across re-indexing — if not, citations need a resolution table.
3. Whether tool-call visibility is ever surfaced to the visitor. Current answer:
   no, so `EngineEvent` has no `tool_call` variant. Adding one later is additive.
4. Multi-turn context window policy: how many prior turns are sent, and whether
   summarization is the BFF's job or the profile's.

---

## Output limits — what is and is not bounded

`EngineRunLimits.maxDeliveredOutputUnits` was called `maxOutputTokens` and that
name promised something no adapter in this engine family can keep.

| | Bounded by | Enforced where |
|---|---|---|
| Output **delivered to this process** | `maxDeliveredOutputUnits` | The adapter, on a script-aware estimate, aborting mid-stream |
| Tokens **generated and billed by the vendor** | `EngineCapabilities.vendorMaxOutputTokens` | The engine's own configuration; we cannot influence it per run |

Two facts force the split.

**The protocol reports usage only when the answer is complete.** A limit that
can act during the stream therefore has to work from an estimate. The estimate
is script-aware and biased to trip early — see `estimateOutputUnits` — but it is
an estimate, and calling it a token count claimed a precision it does not have.

**The vendor accepts no per-run limit.** Probed directly against the running
instance: `max_tokens`, `maxTokens` and `maxOutputTokens` in the request body
all return HTTP 200 and are all ignored; completion tokens varied 34–50 with the
limit set to 1. There is nothing to send.

The consequence for LLD-001's cost model is stated plainly rather than implied:
aborting a stream stops what *we* receive. It does not stop the vendor
finishing. The worst case per abandoned run is `vendorMaxOutputTokens`, not
`maxDeliveredOutputUnits`.
