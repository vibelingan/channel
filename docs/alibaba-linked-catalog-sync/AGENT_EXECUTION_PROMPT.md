# Copy-Paste Prompt for the Implementation Agent

Implement **Channel Alibaba Open Platform Linked Catalog Sync** in `vibelingan/channel`.

Use branch `feature/alibaba-linked-catalog-sync` created from the latest `origin/main`. Treat every document under `docs/alibaba-linked-catalog-sync/` as the frozen implementation contract. Read them in the order defined by `README.md`, then begin MIU 0 from `MIU_BREAKDOWN.md`.

Critical compatibility rule:

- preserve `unitPrice`, `wholesalePrice`, `vipPrice`, `PriceBlock`, `canSeeVipPricing`, public catalog bearer-token/JWT behavior, existing fixtures/tests, and Overstock pricing;
- do not delete, unset, rename, migrate, or broadly refactor those surfaces;
- Alibaba sync must never write or derive from the legacy price fields;
- add the exact Alibaba-prefixed collections and product fields specified in the documents;
- linked products render `alibabaCatalogPricing`; linked products with unavailable Alibaba pricing must not fall back to legacy prices;
- unlinked products must behave exactly as they do now.

Do not introduce generic integration naming, scraping, fuzzy matching, automatic publication, FX, markup, payment/order logic, or Medusa.

Start by creating a clean worktree, recording the actual baseline commit, copying the documentation into the repository, and completing MIU 0 evidence. Stop with evidence if an external Alibaba permission or official response-contract gate fails. Do not invent an alternative architecture.
