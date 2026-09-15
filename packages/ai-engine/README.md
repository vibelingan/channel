# `@vibelingan-channel/ai-engine`

The provider-neutral boundary between the Channel AI assistant and whatever
model runtime answers its questions.

Nothing in this package names a vendor, touches a database, or knows what HTTP
is. That is the whole point: the architecture reserves the right to replace the
first engine (Hermes) with a different one through an ADR, and a boundary
written *after* an adapter exists is only ever shaped like that adapter.

## What is in here

| File | Purpose |
|---|---|
| `src/port.ts` | The `ConversationEngine` interface and its types |
| `src/errors.ts` | The closed error taxonomy every adapter maps vendor failures into |
| `src/capabilities.ts` | What an engine guarantees, plus the startup refusal check |
| `src/fake-engine.ts` | A deterministic in-memory engine |
| `src/conformance.ts` | The suite every adapter must pass |
| `src/boundary.test.ts` | The tests that keep this boundary honest over time |

## The three ideas worth knowing

**`createRun` and `streamRun` are separate.** They look like one operation and
are not. Between them, the caller records the vendor's run id and then checks
whether it is still authorised to stream — a control handover may have happened
in between. A combined call would leave nowhere to put either write.

**Capabilities are a startup gate, not documentation.** An adapter declares what
its vendor actually guarantees — replay-safe creation, run lookup, stop,
citations — and `assertEngineUsable()` refuses to serve when a guarantee is
missing and nothing compensates for it. The alternative is discovering the gap
at the first customer. It reports every reason at once rather than the first, so
an operator fixing a misconfiguration sees all of it instead of rediscovering
the next problem on each restart.

**The fake is a real artifact.** It is not a test stub. The BFF's state-machine
and race tests run against it with a real database, so they are deterministic
and need no vendor. It is also the conformance suite's first passing member —
a suite no implementation passes proves nothing.

## Using it

```ts
import { assertEngineUsable, type ConversationEngine } from '@vibelingan-channel/ai-engine';

// At composition root, once, before serving:
assertEngineUsable(engine.capabilities, {
  operationIdMappingLayerConfigured: false,
  unrecordedHandleRecoveryConfigured: false,
  answerPolicyRequiresCitations: true,
  knowledgeSourceConfigured: true,
});
```

The BFF imports this package. It must never import an adapter package — the
engine instance is constructed once at composition root and passed in.

## Writing an adapter

1. New package, e.g. `packages/ai-engine-<vendor>`. One vendor per package: the
   vendor's name appears in exactly one place in the repo, and a test in this
   package enforces that it is not this one.
2. Implement `ConversationEngine`. Map every vendor failure into the error
   taxonomy — the BFF branches on a category and never on a vendor's words.
3. Run the shared conformance suite against it:

```ts
import { runConformanceSuite } from '@vibelingan-channel/ai-engine';
runConformanceSuite('my-vendor', harness);
```

The harness supplies the failure paths the suite cannot otherwise reach — a
vendor 500, a timeout, overlong output, a credential rotation. An adapter that
cannot script a vendor 500 has no way to prove it normalizes one.

**Passing the suite is necessary and nowhere near sufficient.** It proves the
adapter fits the socket. Replacing the serving engine additionally requires an
ADR and equivalent security, cancellation, evaluation, and operations evidence.

## Tests

```bash
corepack pnpm --filter @vibelingan-channel/ai-engine test
corepack pnpm --filter @vibelingan-channel/ai-engine typecheck
```

The boundary tests are the ones that matter a year from now: no vendor name in
this package, no cross-package import, no runtime dependency, and no
database/HTTP/clock type in the port's surface. Each was verified to fail on an
injected defect, so a green run means something.

## Design source

`docs/ai-platform/LLD-002-CONVERSATION-ENGINE-INTERFACE.md` — the owning
low-level design, and `MIU_BREAKDOWN.md` MIU 1 for scope. Where this package and
that document disagree, the document wins and this package is corrected.
