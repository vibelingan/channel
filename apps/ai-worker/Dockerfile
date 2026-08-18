# Multi-stage: the workspace needs the lockfile and every referenced package
# manifest to install deterministically, so the build context is the repo root.
FROM node:22.13.0-alpine AS base
# npm, not corepack: corepack bundled with this node image ships a signing-key
# set that cannot verify pnpm 11.5.0 and fails the build with "Cannot find
# matching keyid". The version is pinned either way, so determinism is kept.
RUN npm install -g pnpm@11.5.0
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ai-engine/package.json packages/ai-engine/
COPY packages/ai-store/package.json packages/ai-store/
COPY apps/ai-worker/package.json apps/ai-worker/
RUN pnpm install --frozen-lockfile --filter @vibelingan-channel/ai-worker...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY tsconfig.base.json ./
COPY packages/ai-engine packages/ai-engine
COPY packages/ai-store packages/ai-store
COPY apps/ai-worker apps/ai-worker

# Never root. CloudRun does not require it, which is exactly why it gets
# forgotten until an image scan flags it.
USER node
EXPOSE 8080
# tsx runs TypeScript directly; the alternative is a compile step whose output
# would need its own drift test against the sources.
# WORKDIR is the package, not the repo root: pnpm keeps tsx in the package's
# own node_modules, and `node --import tsx` resolves from the working directory.
# Running from /app fails with ERR_MODULE_NOT_FOUND for 'tsx'.
WORKDIR /app/apps/ai-worker
CMD ["node", "--import", "tsx", "src/worker.ts"]
