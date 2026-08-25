FROM node:22.13.0-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.5.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @vibelingan-channel/ai-bff build
RUN pnpm --filter @vibelingan-channel/ai-bff deploy --prod --legacy /runtime

FROM node:22.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/apps/ai-bff/dist ./dist
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /runtime/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
