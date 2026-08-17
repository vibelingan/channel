# ADR-002: Retrieval engine for the public customer assistant

- **Date:** 2026-08-17
- **Status:** Proposed — supersedes ADR-001's Hermes + Lexiang serving path
- **Decision:** **AnythingLLM (Docker, self-hosted) as the retrieval engine**, with
  generation policy owned by our BFF, and **pgvector-in-PostgreSQL recorded as the
  designed successor** with named trigger conditions.

---

## 1. What is actually being decided

Not "which RAG tool is best". The question is narrower and it changes the answer:

> What should retrieve and ground answers for an **anonymous public** sales
> assistant, over a **small curated corpus**, for a **~100-person company**, where
> the dominant risk is **inventing a price** rather than failing to find a document?

Three properties of this case rule out most of the market's assumptions:

1. **We already have the chat interface.** The widget and the BFF exist by design.
   Anything that is primarily a chat UI is ~80% waste.
2. **The corpus is tiny.** MOQ, price factors, lead times, certificates, OEM
   process. Realistically tens to low hundreds of documents — a few thousand
   chunks.
3. **The stakes are asymmetric.** A missed answer costs a refusal, which the
   product contract explicitly allows. A *confident wrong price* is a commercial
   commitment to a stranger. In May 2026 a European banking consortium was fined
   under the EU AI Act for exactly this class of failure in a customer-facing RAG
   chatbot.

So retrieval *recall* — where most platform benchmarks compete — is nearly
irrelevant here. **Grounding discipline, citations and refusal** are the whole
game.

---

## 2. The option space

The 2026 landscape sorts into four categories, and most teams assemble one from
each. Naming the category matters, because picking from the wrong one is how a
project ends up with 80% unused surface.

| Category | Examples | Fit for us |
|---|---|---|
| RAG libraries | LangChain, LlamaIndex, DSPy | Building blocks; we would still write the service |
| Chat interfaces with RAG | **AnythingLLM**, Open WebUI, LibreChat, Onyx, Verba | We only want the engine half |
| LLM app platforms | **Dify**, Flowise, Langflow | We already have the app |
| Managed cloud | Tencent LKE/ADP, Bedrock KB, Vertex AI Search | Lock-in; ADR-001 already declined ADP |

### Candidates evaluated

**A. Hermes + Lexiang — the current design (status quo)**

- **For:** already designed and reviewed; Hermes' Runs API has a genuine
  out-of-band `stop` endpoint, which LLD-001's cancel worker was written against.
- **Against:** two components and two credentials in the serving path. Lexiang is
  an internal-wiki product being repurposed for anonymous public serving, and its
  isolation is a *permission construct we must prove* — the K1–K5 probe is the
  most expensive unproven item in MIU 0 and the highest-consequence gate in
  SECURITY.md. Hermes is self-operated: our own ops manual records a production
  incident and its RCA.

**B. AnythingLLM**

- 63.7k GitHub stars, MIT, Docker, multi-user in the Docker build.
- Independent 2026 benchmark, 5,047-page corpus, 50 queries: **6% hallucination**
  (PrivateGPT 11%, Open WebUI 14%); **best citations** — filename + page,
  clickable, verbatim chunk, 9/10 correct.
- Exposes an OpenAI-compatible endpoint. **Verified on this machine:**
  `/api/v1/openai/chat/completions` responds; `/api/ping` → `{"online":true}`.
- **Against:** primarily a chat product — we use a fraction. Benchmarked to
  "crack around 10,000 pages" (two orders of magnitude above our corpus). The
  *desktop* build ships closed-source telemetry; the Docker build is mandatory.

**C. Dify**

- Largest community (~114k stars). Every app gets a REST API. Visual workflow
  builder, citations, self-hostable.
- **Against:** it is an application-building platform and we already have the
  application. Heaviest operational footprint of the candidates for the least
  incremental benefit.

**D. RAGFlow**

- ~70k stars. Its differentiator is **deep document parsing** — multi-column PDFs,
  tables, scanned documents — plus GraphRAG.
- **Genuinely relevant:** certificates are likely PDFs, possibly scanned. This is
  the one capability we may actually miss elsewhere.
- **Against:** heavier; GraphRAG is complexity we have no use for. Keep as the
  fallback if certificate parsing proves to be the binding constraint.

**E. pgvector, native in our own PostgreSQL**

- We are **already buying PostgreSQL** for the conversation store.
- 2026 consensus: pgvector is the right choice below ~1–5M chunks; some sources
  say up to 50–100M. **Our corpus is ~3 orders of magnitude below that floor.**
- "Data gravity": embeddings beside conversations means joins, transactions and
  row-level security for free, and one fewer service to patch, monitor and back
  up — which matters more at 100 people than at 1,000.
- **Against:** we would build chunking, embedding, retrieval and re-ranking
  ourselves, and getting chunking wrong degrades answers *silently*. No document
  parsing for PDFs. **No content-management UI** — the sales team could not update
  the FAQ without a developer, so that becomes another MIU.

**F. Tencent LKE / ADP (managed)**

- Native to the cloud we are already on; Chinese compliance posture.
- **Against:** ADR-001 already declined ADP to avoid platform binding, and
  nothing has changed that reasoning. Pricing is opaque. Least control over the
  refusal behaviour that is our dominant risk.

---

## 3. The finding that constrains every option except the status quo

**No OpenAI-compatible chat-completions API has an out-of-band stop.** That is a
property of the protocol, not of any product. Cancellation is done by *closing the
connection*, which only the process holding it can do.

Verified empirically against zenmux: aborting a streaming request terminated
cleanly (`AbortError` at 2,505ms).

LLD-001 assumed otherwise. Its **cancel worker** stops a run that a *different*
worker is streaming, which Hermes' Runs API supports and an OpenAI-compatible
endpoint does not. `LLD-002` makes `supportsStop` a **startup-blocking**
capability, so adopting any OpenAI-compatible engine fails that check as written.

**This is not a correctness hole.** The database fence in LLD-001 §4.2 means no
assistant text is ever committed after a takeover, whatever the model is doing.
It is a **cost and resource** hole: the model keeps generating, and billing, until
it finishes on its own.

**Resolution, and it must be written into LLD-001 and LLD-002:**

1. Redefine `supportsStop` as *"an in-flight run can be cancelled by the worker
   that owns it"* — satisfied by connection abort.
2. The owning worker checks `cancel_requested_at` between streamed events (it
   already does, per §4.3's fence terms) and aborts its own connection.
3. Add `supportsOutOfBandStop` as a **separate, non-blocking** capability. True
   for Hermes, false for OpenAI-compatible engines. Where false, the worst case is
   bounded waste of one run's remaining `maxOutputTokens`, and that bound must be
   recorded in the budget model.

---

## 4. Decision

**Adopt AnythingLLM (Docker) as the retrieval engine for the pilot and the first
production release.** Retire Hermes and Lexiang from the assistant's serving path.

**Generation policy stays in our BFF.** Where AnythingLLM exposes retrieval
separately from generation, prefer that shape: we retrieve chunks from it, apply
our own answer policy and refusal rules, and call the model ourselves. Handing an
external product control of the system prompt would put our highest-stakes rule —
never invent a price — inside a component we do not review.

### Why, in order of weight

1. **It removes the highest-risk unproven item on the plan.** Lexiang's
   public-space isolation (K1–K5) is the most expensive MIU 0 probe and the
   highest-consequence security gate. A workspace we own end to end, containing
   only material we published into it, replaces a permission boundary we must
   continuously prove with a corpus that is public by construction.
2. **It wins the two metrics this product depends on.** Lowest measured
   hallucination and the best citations of the self-hosted field. Those are
   literally the answer policy's requirements.
3. **It removes a component and a self-operated service.** One engine instead of
   Hermes plus Lexiang. For a 100-person company, one fewer thing to patch is a
   real architectural benefit, not a rounding error.
4. **The corpus is far inside its limits**, and the sales team gets an ingestion
   UI without us building an admin MIU.
5. **The exit is already built.** `ConversationEngine` (MIU 1) means changing
   engine costs one adapter package. That was the entire point of writing the port
   before any vendor existed.

### Conditions on the decision

- **Docker build only.** The desktop build's closed-source telemetry is
  disqualifying for anything that sees customer questions.
- **Pin the image digest**, exactly as the architecture already requires for
  Hermes. Not `latest`.
- The gate that mattered for Hermes — *what can this engine actually do on our
  behalf* — still applies. Enumerate AnythingLLM's enabled tools/agent skills and
  disable everything that is not retrieval.

---

## 5. pgvector is the designed successor, not a rejected option

Record now, so a future team does not re-litigate from scratch. **Move retrieval
into our own PostgreSQL when any of these fires:**

| Trigger | Why it changes the answer |
|---|---|
| Corpus approaches ~10,000 pages | AnythingLLM's benchmarked degradation point |
| We need retrieval joined to relational state (e.g. per-product, per-region answers) | Data gravity — a separate engine cannot join to `products` |
| Operating a second service becomes the dominant cost | pgvector removes it entirely; we already run PostgreSQL |
| Retention or deletion must cover the index transactionally | One database, one transaction, one deletion path |

At our scale pgvector is *technically sufficient today*. It is not chosen now for
one reason: it has no ingestion pipeline or content UI, so choosing it converts a
configuration task into two additional MIUs and delays the pilot. That is a
schedule judgement, not a technical one, and it should be revisited once the
pilot has real traffic.

---

## 6. Consequences

**Positive:** one fewer component and credential; the hardest security probe
becomes far cheaper; measurably better grounding and citations; a content UI for
non-developers; the engine port proves its worth on first use.

**Negative:** a second service to run and patch (until pgvector); no out-of-band
cancellation, so bounded token waste on takeover; we adopt a product whose primary
use case is not ours, so upstream changes may not serve us.

**Unproven, and must be closed before production:**

| # | Question | Blocks |
|---|---|---|
| 1 | Does AnythingLLM expose **retrieval separately from generation**? | The preferred integration shape in §4 |
| 2 | Does its API return citations mappable to `EngineCitation`? | `supportsCitations`; the answer policy |
| 3 | Does streaming work through its OpenAI-compatible endpoint? | Token-by-token delivery |
| 4 | Can it parse the certificate PDFs we actually have? | If not, RAGFlow becomes the candidate |
| 5 | What is its full enabled tool/agent surface? | Same class as the Hermes toolset gate |

**Superseded:** ADR-001's Hermes + Lexiang serving path. ADR-001's other
decisions — BFF ownership, the takeover consistency model, the security posture —
stand unchanged.

---

## 7. Model provider (unchanged by this ADR, recorded for completeness)

zenmux, OpenAI-compatible, `https://zenmux.ai/api/v1`, 156 models. Verified live:
**`z-ai/glm-5.2`** primary, **`moonshotai/kimi-k3`** fallback. Neither
`z-ai/glm-5.3` nor `kimi/k3` exists.

Both are **reasoning models whose reasoning tokens are billed inside the
completion budget**. At `max_tokens: 30` both returned an **empty answer with no
error**; Kimi spent 103 reasoning tokens on a one-sentence reply. Therefore
`maxOutputTokens` must carry reasoning headroom, and the adapter must treat empty
content with non-zero completion tokens as a **failure**, not a successful blank
answer.
