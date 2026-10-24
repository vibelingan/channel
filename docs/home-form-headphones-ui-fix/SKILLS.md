# Skill and Stack Routing

> Phase 2 record for the Home Form and Headphones UI Fix. This file pins which guidance later phases may rely on; missing skills use the recorded fallback and never silently become installed dependencies.

## Verified Stack

- Node.js 22.12+ for the locked Astro 6.4.6 build toolchain and pnpm workspace; CloudBase functions remain on their separately configured Nodejs20.19 runtime
- TypeScript 5.6
- Astro 6.4 with React 19 islands
- Tailwind CSS 4 design tokens
- TanStack Query 5 for client catalog fetching
- CloudBase functions, NoSQL, and protected media storage
- node:test through `tsx` plus Playwright 1.61 browser coverage
- Biome 1.9 and Astro Check

## Active Sources

| Source | Relevance | Status | Use |
|---|---|---|---|
| `vercel-react-best-practices` | High | Installed | React 19 rendering, async state, and bundle discipline |
| `vercel-composition-patterns` | High | Installed | Reusable public form-control and storefront component contracts |
| `ui-ux-pro-max` | High | Installed | Phase 3 interaction, responsive, state, and visual specification |
| `engineering-craft` | High | Installed | Frontend islands, projection, counter-integrity, and E2E rules |
| `cross-file-reasoning` | High | Installed | Producer/consumer and conditional lifecycle checks |
| `cloudbase` | High | Installed | Media counter diagnosis and protected delivery behavior |
| `web-design-guidelines` | Medium | Installed | Phase 3 accessibility and interface audit |
| `nodejs-testing` | Medium | Installed | Typed fixtures and behavior-focused tests |

## Missing Sources And Fallbacks

| Signal | Missing source | Executable fallback |
|---|---|---|
| Astro islands and forms | `astro-idioms` | Context7 against current Astro 6 documentation |
| TypeScript | `typescript-best-practices` | Context7 TypeScript documentation plus strict project checks |
| Browser E2E patterns | `playwright-e2e` | Installed official Playwright tooling and current documentation |
| Zod validation | No pinned installed source | Context7 Zod documentation if the validation contract changes |
| TanStack Query | No published router source | Context7 TanStack Query documentation if fetching changes |
| Tailwind CSS 4 | No dedicated router source | Installed design skills plus Context7 Tailwind 4 documentation |

## Selection Boundary

- No select/headless component library is installed or selected in Phase 2.
- A candidate may be approved only as a reusable project primitive in the architecture gate, after its current package source/types and official documentation are recorded.
- Missing optional guidance does not justify installing an unverified skill. Context7 is available, current, and sufficient for the missing Astro contract.