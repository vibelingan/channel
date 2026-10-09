# Retro: catalog single source of truth (2026-10-02 → 2026-10-09)

Material for the retrospective of this feature, written from the full session
history (the owner's messages, the execution log, the commits and the
production checks). It is kept up to date while work continues.

| Doc | What it answers |
|---|---|
| [TIMELINE.md](TIMELINE.md) | What happened, day by day: what the owner asked, what was built, what went live |
| [PROBLEMS_AND_FIXES.md](PROBLEMS_AND_FIXES.md) | Every problem we hit (product bugs, data, tooling, process): cause, what we tried, how it was resolved, lesson |
| [DESIGN_AS_BUILT.md](DESIGN_AS_BUILT.md) | How the system works now, area by area, with the decisions behind it and what is still open |
| [RETRO_PLAN.md](RETRO_PLAN.md) | The replanned follow-up: 22 worked cases to write (code before/after, wrong model, evidence), decisions that may still be wrong, which skills are worth making, detailed pipeline and spec-forge changes |
| [RETRO.md](RETRO.md) | The retrospective: business, workflow, technical, delivery and testing — what went well, what didn't, and where each lesson should live (proposals) |

The detailed records stay where they were: [DESIGN.md](../DESIGN.md) (decisions
DEC-1…DEC-20, OWN-1/2), [MIU_BREAKDOWN.md](../MIU_BREAKDOWN.md) (every work
unit) and [EXECUTION_LOG.md](../EXECUTION_LOG.md) (per-unit log, runbook,
reviews).

## In one paragraph

On 2026-10-06 the owner found that 21 live products showed one price on the
list and another on the product page. The cause was two copies of the price
written by two different paths. Over four days we rebuilt the catalog so that
the list, the product page and the quote request all read one approved version
per product, for synced and manual products alike. Approval became the only
way anything reaches the public site, and every admin entry point that
publishes now runs that approval itself. Along the way the owner asked for
supplier changes to be reviewed side by side instead of applied silently,
faster publishing, photos copied into our storage before an admin sees a
draft, and each product treated as one unit (all of it ready, or none of it
shown).

## Results (production, 2026-10-09)

- List card and product page agree for every listed product: audit 139
  listed, 139 approved, 0 mismatches, 0 errors.
- The 21 wrong-price products were hidden, rebuilt and re-approved; each
  card now shows the lowest configuration price that the page also shows.
- The 7 manual products use the same approved version and page as synced
  ones.
- Publishing a product takes about 4–6 s instead of 15–25 s (the approval
  itself is one request of about 2 s); batch publish runs four products at a
  time.
- Supplier changes on approved products are flagged; the admin reviews text
  and photos side by side and chooses per part; prices and configurations
  always take Alibaba's latest.
- Every Alibaba draft (955 now) has its photos in our
  storage and none is hidden; 6 drafts miss 7 photos Alibaba cannot provide
  (one deleted, two refused, four animated GIFs our storage doesn't take).
- Every draft can be published from "Assign category → Save and publish"
  (single or batch): all have photos, none exceeds the approval's image
  limit, none is flagged "Changed"; 56 still need a product family.
- Classification "Save and publish" (single and batch) publishes Alibaba
  drafts; the product list has "Go to page".
- Admin list thumbnails load for every product again (drafts show the
  Alibaba original their photo was copied from); GIF photos are supported
  from storage to the website.
- The website search no longer matches Alibaba product IDs; the admin search
  still does.

## Still open (owner's or follow-up)

- R7: the owner reviews the 9 products flagged "Changed" (7 price-only, 2
  with new photos to Keep or Use).
- Supplier action for the client: the clock product (`33e4983e`, "Home Decor
  Nordic Creative Silent Clocks…") has two photos Alibaba blocks (403); only
  the supplier can re-upload them.
- Follow-ups: Alibaba description previews in the Supplier changes panel
  don't load; an old notice overlaps the panel; the panel takes 5–10 s to
  load; the sync timer is off, so photo copying runs only from the Sync page;
  deploys take about an hour (task chip "Speed up test deploys").
