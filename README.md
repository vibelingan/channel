# Channel Technology Limited — Portal

A fresh, monorepo portal built with **Astro** + **TailwindCSS**, a **React** admin,
and a **CloudBase (wx-server-sdk)** backend. Data is managed through a single
**registry-driven admin**: every collection is described once and the admin UI and
server validation are derived from that description.

## Architecture

```
channel/
├─ apps/
│  ├─ site/                 @vibelingan-channel/site — Astro 6 + Tailwind 4 + React 19 admin
│  ├─ functions/
│  │  └─ admin/             @vibelingan-channel/fn-admin — generic CRUD cloud function (wx-server-sdk)
│  └─ local-server/         @vibelingan-channel/local-server — Express + file-backed local DB
└─ packages/
   ├─ shared/               @vibelingan-channel/shared — collection registry, schemas, API envelope
   ├─ auth/                 @vibelingan-channel/auth — argon2 passwords + JWT (jose)
   └─ db/                   @vibelingan-channel/db — adapter pattern (CloudBase / local) + repository
```

### Key ideas

- **Add a collection in one place.** Append a `CollectionDef` to `COLLECTIONS` in
  [packages/shared/src/collections.ts](packages/shared/src/collections.ts). The admin
  table, the create/edit form, the searchable fields, and the server-side validation
  schema are all derived from it — no other file changes are required.
- **Adapter pattern for persistence.** Backend code talks to a `DbAdapter`, never a
  database directly. Production wires the CloudBase (wx-server-sdk) adapter; local
  development wires a JSON-file adapter that persists edits to `apps/local-server/data/`.
- **One handler, two runtimes.** The cloud function and the local-server share the same
  [handler](apps/functions/admin/src/handler.ts); only the wired adapter differs.
- **Secure admin.** Password login issues a short-lived JWT; every non-login action
  requires a valid token, and unknown collections / unknown fields are rejected.

## Getting started

```bash
pnpm install
cp .env.example .env   # adjust as needed
```

### Local development (offline, file-backed DB)

Run the local API and the site in two terminals:

```bash
pnpm dev:api    # @vibelingan-channel/local-server on http://localhost:3002
pnpm dev        # Astro site on http://localhost:4321 (proxies /api -> local-server)
```

Open <http://localhost:4321/admin> and sign in with the dev password (`admin` by
default, see `ADMIN_PASSWORD`). Edits are written to
`apps/local-server/data/db.local.json` so they survive restarts.

### Production (CloudBase)

The admin function (`apps/functions/admin`) deploys to CloudBase. It requires:

- `TCB_ENV` — CloudBase environment id (wx-server-sdk `cloud.init`)
- `JWT_SECRET` — secret used to sign admin tokens
- `ADMIN_PASSWORD_HASH` — argon2id hash of the admin password (preferred)

Build all functions with `pnpm build:functions`.

## Useful scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Run the Astro site |
| `pnpm dev:api` | Run the local file-backed API server |
| `pnpm build` | Build the Astro site |
| `pnpm build:functions` | Build all cloud functions |
| `pnpm typecheck` | Type-check every workspace |
| `pnpm lint` | Lint with Biome |
