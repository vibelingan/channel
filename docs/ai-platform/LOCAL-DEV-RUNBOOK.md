# Running the assistant on your own machine

What this gets you: a working customer assistant you can type at, answering from
the website's own content, with clickable links to the page each answer came
from. Nothing is deployed and nothing costs cloud money — the only paid part is
the model itself, billed per question through zenmux.

---

## 1. One-time setup

You need Docker running. The normal application path uses the deterministic
fake engine and needs no `.env.ai` or model key:

```bash
pnpm dev:ai
pnpm smoke:ai
```

For the optional pinned local AnythingLLM profile, copy `.env.ai.example` to
the gitignored `.env.ai` and fill every attestation/corpus field, not only the
provider key:

| Key | What it is |
|---|---|
| `GENERIC_OPEN_AI_API_KEY` | The zenmux key. The model provider |
| `ANYTHINGLLM_API_KEY` | Generated locally, see below |
| `AI_KNOWLEDGE_CREDENTIAL_ID` | First 16 lowercase hex characters of SHA-256 of the API key |
| `AI_ENGINE_VERSION`, `AI_ENGINE_IMAGE_DIGEST` | Must remain `1.16.0` and the pinned digest unless the image is deliberately reviewed and upgraded |
| `ANYTHINGLLM_WORKSPACE_SLUG`, `AI_APPROVED_SOURCE_PREFIX` | The dedicated public corpus and its document namespace |
| `ANYTHINGLLM_CITATIONS_VERIFIED` | Set to `1` only after this exact workspace returns real citations |
| `JWT_SECRET`, `SIG_KEY`, `SIG_SALT` | Any long random strings, set once |

Start PostgreSQL and the pinned KB first:

```bash
pnpm dev:ai:full
```

If `ANYTHINGLLM_API_KEY` is not yet in `.env.ai`, use the non-printing helper.
It calls only the loopback container, atomically stores both the key and its
attestation in `.env.ai`, and sets the file mode to `0600`; the key never goes
to terminal output:

```bash
pnpm ai:key:generate
```

Configure the dedicated workspace, then set
`ANYTHINGLLM_CITATIONS_VERIFIED=1` only after a successful citation-bearing
probe:

Then load the content and the answer policy:

```bash
pnpm ai:setup
```

Finally build and start the BFF and worker with the complete profile:

```bash
pnpm dev:ai:build
pnpm smoke:ai
```

This is safe to re-run. It replaces the previous content rather than adding a
second copy — which matters, because a stale duplicate produces a wrong answer
carrying a real citation.

---

## 2. Use it

Open **http://localhost:58080/dev/chat** and ask something a customer would ask.

The page shows what the assistant said, which pages it drew from, and how long
it took.

**The answer appears all at once, not word by word.** That is deliberate: an
answer is checked for commercial commitments the sources do not support — an
invented price, discount, delivery date or certification — and a check that runs
after the words are on screen cannot take them back. The engine returns its
sources only at the end, so there is nothing to check against until the answer
is complete. While it works, the server sends content-free keep-alive comments
rather than partial text. The banner at the top reports whether the database is genuinely usable.

The Send button becomes Stop while an answer is streaming. Pressing it closes
the connection, which is the only way to cancel with this engine — see
LLD-002 §7.1.

---

## 3. Check the answers are still good

```bash
pnpm ai:eval
```

Eight questions, half of which the website answers and half of which it
deliberately does not. It fails if the assistant invents a price, speaks about
the company in the third person, mentions its own retrieval machinery, or
refuses something the site actually publishes.

It calls a real model, so it is not deterministic and is not in CI. Run it after
changing `apps/ai-bff/policy/public-sales-v1.txt` or the website content.

---

## 4. Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev:ai` | Start the stack |
| `pnpm dev:ai:build` | Rebuild the images and start |
| `pnpm dev:ai:logs` | Follow the BFF's log |
| `pnpm dev:ai:down` | Stop everything |
| `pnpm ai:setup` | Reload content and answer policy |
| `pnpm ai:eval` | Check answer quality |
| `pnpm test:ai` | Unit tests, no model needed |
| `pnpm smoke:ai` | Health and readiness of both services |

Ports are all in the 5xxxx range on purpose — see the note at the top of
`docker-compose.ai.yml`. AnythingLLM's own admin UI is at
**http://localhost:53001** if you want to inspect the corpus by hand.

---

## 5. Historical limitations of the old local harness

The bullets below describe the pre-MIU runtime retained for historical review;
they are not the current BFF/store/worker implementation status. ADR-002, the
MIU trace and the Phase 1 handoff are authoritative for the current path.

Worth knowing before you judge what you are looking at.

- **No conversation is remembered between page loads.** History lives in the
  browser tab. The run lifecycle, the ordered event log and the database-backed
  conversation are LLD-001 work in MIU 2c/5b/5c.
- **No human takeover.** A salesperson cannot take a conversation over yet.
- **No rate limiting and no abuse controls** on the chat route. It is not
  exposed to the internet and must not be until those exist.
- **Answer policy lives in the engine's workspace, not in our service.**
  ADR-002 §4 wants the opposite — retrieve from the engine, apply our own policy,
  call the model ourselves — so that the rule "never invent a price" sits in code
  we review. The policy text is already in `apps/ai-bff/policy/` ready for that
  move; only the delivery changes.
- **Everything here runs behind one switch: `AI_LOCAL_HARNESS=1`.** It turns on
  the `/dev/chat` page, the `/api/ai/chat` route, and permission to serve with
  unmet engine guarantees — three things that are really one decision, because
  the route has no rate limiting, no admission control and no takeover fence.

  Without that flag the conversation route **does not exist**: it answers 404,
  the same as a route nobody ever wrote. With the flag set in a production
  environment (`NODE_ENV=production` or `APP_ENV=production`), the service
  refuses to start and says why.

  **Correction to an earlier version of this document.** It claimed that copying
  `docker-compose.ai.yml` onto a real server "fails loudly". That was wrong.
  Compose declares `development`, so the harness is permitted and the stack
  starts normally. What fails closed is the production **image** and the
  **CloudRun manifest** — not this file.

  What protects the local stack is that every published port binds to
  `127.0.0.1` only. Before that change all four services bound `0.0.0.0` and
  `::`, which put a PostgreSQL with static credentials, the AnythingLLM
  administration console, and an unauthenticated chat route on every network the
  laptop was attached to. `scripts/compose-ports.test.mjs` fails if a port is
  ever published without the loopback prefix.

---

## 6. When something looks wrong

**Answers are stale after editing website content** — re-run `pnpm ai:setup`.
The corpus is a copy; editing the site does not update it.

**The assistant refuses a question the site answers** — the fact is probably in
the corpus but phrased for scanning rather than asking. `KEY_FACTS` in
`scripts/ai-ingest-content.mjs` pairs high-traffic questions with the exact
values from the content files; add the fact there. This is how "how long have
you been in business?" was fixed while "Since 2004" was already loaded.

**First token takes several seconds** — expected. These are reasoning models and
they think before emitting anything visible. Roughly 3–6s to first token locally.

**A blank answer with no error** — the token budget was too small and the model
spent all of it reasoning. The adapter now reports this as a failure rather than
an empty success, so you should see an error instead.
