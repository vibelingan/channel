# Quick Start

Get the Channel portal running in a couple of minutes.

## 1. Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | >= 20 (24 recommended) |
| pnpm | >= 11 (`corepack enable pnpm`) |

## 2. Restore the project

```bash
pnpm install
```

If pnpm reports **"Ignored build scripts"**, approve the native packages once:

```bash
pnpm approve-builds        # press "a" to select all, then "y" to confirm
```

These are `esbuild`, `sharp`, `@biomejs/biome`, and `protobufjs`.

Then copy the example env file:

```bash
cp .env.example .env       # Windows: Copy-Item .env.example .env
```

## 3. Develop locally (offline)

Run the API and the site in two terminals:

```bash
pnpm dev:api               # local file-backed API  -> http://localhost:3002
pnpm dev                   # Astro site             -> http://localhost:4321
```

Open <http://localhost:4321/admin> and sign in with the dev password **`admin`**.

- Data is stored in `apps/local-server/data/db.local.json` and survives restarts.
- The site proxies `/api/*` to the local server, so there are no CORS issues.

## 4. Build

```bash
pnpm build                 # build the Astro site  -> apps/site/dist
pnpm build:functions       # bundle cloud functions -> apps/functions/*/dist
pnpm package:functions     # build deploy artifacts -> .cloudbase-artifacts/functions
```

## 5. Check everything

```bash
pnpm typecheck             # type-check every workspace
pnpm lint                  # Biome lint
pnpm format                # Biome auto-format
```

## Add a new collection

Append one entry to `COLLECTIONS` in
[`packages/shared/src/collections.ts`](../packages/shared/src/collections.ts).
The admin table, the create/edit form, search, and server-side validation are all
derived from it — no other file needs to change.

```ts
{
  name: 'products',
  label: 'Products',
  searchableFields: ['title', 'sku'],
  fields: [
    { name: 'title', label: 'Title', type: 'string', required: true },
    { name: 'sku', label: 'SKU', type: 'string', required: true },
    { name: 'price', label: 'Price', type: 'number' },
    { name: 'active', label: 'Active', type: 'boolean' },
  ],
}
```

## Command reference

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run the Astro site |
| `pnpm dev:api` | Run the local file-backed API server |
| `pnpm build` | Build the Astro site |
| `pnpm build:functions` | Bundle all cloud functions |
| `pnpm package:functions` | Build CloudBase function artifacts |
| `pnpm smoke:functions` | Smoke-test packaged function artifacts |
| `pnpm typecheck` | Type-check every workspace |
| `pnpm lint` | Lint with Biome |
| `pnpm format` | Auto-format with Biome |

## Deploy to production (CloudBase)

The admin function (`apps/functions/admin`) runs on CloudBase with `wx-server-sdk`.
Set these environment variables in the function configuration:

| Variable | Description |
| --- | --- |
| `TCB_ENV` | CloudBase environment id |
| `JWT_SECRET` | Secret used to sign admin tokens |
| `ADMIN_PASSWORD_HASH` | hash-wasm argon2id hash of the admin password |

Build with `pnpm package:functions`, then deploy the matching directory under
`.cloudbase-artifacts/functions/<function-name>`.
