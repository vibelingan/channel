# Running the assistant on your own machine

What this gets you: a working customer assistant you can type at, answering from
the website's own content, with clickable links to the page each answer came
from. Nothing is deployed and nothing costs cloud money — the only paid part is
the model itself, billed per question through zenmux.

---

## 1. One-time setup

You need Docker running and a `.env.ai` file in the repo root. It is gitignored;
copy `.env.ai.example` and fill it in. It holds four values:

| Key | What it is |
|---|---|
| `GENERIC_OPEN_AI_API_KEY` | The zenmux key. The model provider |
| `ANYTHINGLLM_API_KEY` | Generated locally, see below |
| `JWT_SECRET`, `SIG_KEY`, `SIG_SALT` | Any long random strings, set once |

Start everything:

```bash
pnpm dev:ai
```

That brings up four containers: PostgreSQL, AnythingLLM (the retrieval engine),
the BFF, and the worker.

If `ANYTHINGLLM_API_KEY` is not yet in `.env.ai`, generate one against the
running container and paste it in:

```bash
curl -s -X POST http://localhost:53001/api/system/generate-api-key
```

Then load the content and the answer policy:

```bash
pnpm ai:setup
```

This is safe to re-run. It replaces the previous content rather than adding a
second copy — which matters, because a stale duplicate produces a wrong answer
carrying a real citation.

---

## 2. Use it

Open **http://localhost:58080/dev/chat** and ask something a customer would ask.

The page shows what the assistant said, which pages it drew from, and how long
it took. The banner at the top reports whether the database is genuinely usable.

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

## 5. What is deliberately not built yet

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
  refuses to start and says why. Copying `docker-compose.ai.yml` onto a real
  server therefore fails loudly instead of quietly publishing an
  unauthenticated assistant.

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
