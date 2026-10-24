# Headphones Performance Architecture

> Measured baseline and G3 adjustment proposal, 2026-07-28. The current public environment was read only; every response body was drained.

## Public Custom-Domain Test Baseline

Measured from the CloudBase service domain with four concurrent image requests:

| Surface | Current result |
|---|---:|
| Catalog response | 5 products, 6.3KB, about 4.0s, `private, no-cache`, varies by Origin and Authorization |
| Card images | 5 requested by the current cards; 4 x 200 + 1 x 404; about 646KB successful bytes |
| Largest card image | 209KB |
| Slowest card image | about 11.6s |
| Full gallery references in payload | 36 URLs |
| Full gallery direct probe | 18 x 200 + 18 x failure; about 3.8MB successful bytes |
| Public image caching | `public, max-age=3600`; no ETag or observed Age header |
| Immediate repeated primary image request | about 3.7s; no observed edge-cache Age |

The probe timing is a point measurement, not field RUM. It is sufficient to show the dominant risk: media/API network latency and original bytes, not React render computation.

## Rendering Decision

Keep Astro static generation for the page shell, hero copy, media geometry, Product Line heading, loading state, and no-JavaScript recovery. Hydrate the catalog with `client:load`.

Do not migrate this page to on-demand server SSR in this delivery:

- Current hosting is static.
- Session identity is read from browser storage.
- Catalog responses vary by Authorization because VIP fields differ.
- Build-time catalog SSR would publish a stale anonymous snapshot and weaken publication/revocation freshness.
- A new server runtime would increase topology, TTFB and operational cost without removing the media bottleneck.

## Baseline Optimization Plan

### Initial HTML And LCP

- Put the hero `<img>` source in initial HTML; never insert the LCP image only after JavaScript.
- `loading="eager"` and `fetchpriority="high"` on only the primary hero image.
- Reserve intrinsic dimensions/aspect ratio so the hero does not shift.
- Add one preconnect for the configured API/media origin when it is cross-origin.
- Do not preload fallback hero sources; they use low/default priority only after failure.

### Catalog Request

- One initial catalog request after `client:load` and session resolution.
- Page size 12 rather than 48: three desktop rows, bounded JSON and image discovery.
- Explicit Load More; page requests are abortable, user-triggered, and ID-deduplicated.
- No TanStack Query migration: one controller request chain does not justify another abstraction.
- No speculative anonymous preload: it cannot safely satisfy a later Authorization-varying request.

### Product And Gallery Media

- Card only renders the primary image; below-fold cards use native `loading="lazy"`, `decoding="async"`, and stable square geometry.
- Detail/gallery stays unmounted until the user selects a product.
- On detail open, the active image loads normally and at most four thumbnail previews mount with lazy loading and low fetch priority. `View All` explicitly reveals the rest.
- Failed sources advance once and terminate at a stable fallback; no retries or image error loop.
- Do not eagerly download all 36 gallery URLs.

### Cache And CDN

- Keep the current one-hour public cache for gated product media in this delivery.
- Do not add `stale-while-revalidate` because it can extend visibility after unpublish/revocation.
- Do not claim the current service route is CDN-effective: repeat probes exposed no Age/ETag and remained slow.
- CloudBase basic image transforms are feasible, but the current adapter/public route only fetches originals and private signature behavior is not yet proven. `IMAGE-VARIANTS.md` defines the billing, SDK, security, lifecycle, and live-probe gates. No transform or persistent derivative ships here.

## Hero Delivery Decision

The current reviewed hero image is 63KB but the gated function route took about 4.2s. This delivery chooses the **gated hero** to preserve exact publication/refcount revocation. Initial-HTML discovery, preconnect and high fetch priority improve discovery but may not overcome measured origin latency; that risk is explicit in G3.

A curated static marketing derivative remains a valid future performance option only after the image is independently approved as public marketing content. That choice changes retirement from automatic refcount revocation to explicit content/deploy pruning, so it requires a revised architecture and hero MIU before implementation.

A CDN in front of the gated route is a third future option, not the default: it requires invalidation/purge and a verified custom-domain cache topology.

## Verification Budgets

- Exactly one initial catalog request.
- Initial page size is 12 or fewer.
- No non-hero gallery image request before a product detail opens.
- Detail open discovers no more than the active image plus four thumbnail previews before `View All`.
- Only the primary hero receives high fetch priority; fallback and thumbnails do not compete with it.
- Every rendered image reserves geometry; no product image failure changes card/detail dimensions.
- Resource-timing evidence records initial request count and transferred bytes at 390px and 1440px.
- Target LCP is <=2.5s at p75 when enough field data exists; deployment acceptance records lab LCP and the LCP element but does not mislabel one lab run as field proof.
- If the deployed optimized page still misses the LCP target, the next decision is image CDN/derivative infrastructure, not more client state.
