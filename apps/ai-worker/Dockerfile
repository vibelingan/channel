FROM node:22.13.0-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.5.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @vibelingan-channel/ai-worker build
RUN pnpm --filter @vibelingan-channel/ai-worker deploy --prod --legacy /runtime

FROM node:22.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/apps/ai-worker/dist ./dist
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /runtime/package.json ./package.json
# TencentDB for PostgreSQL CA bundle: Tencent Root CA + the TencentDB intermediate.
# DATABASE_URL points sslrootcert here with sslmode=verify-full. It must contain
# BOTH certificates: Node 22 refuses a chain whose trust file holds only the
# intermediate. Shipped as .crt because .dockerignore excludes *.pem to keep
# private keys out of images, which would silently drop a .pem from the build.
COPY certs/tencentdb-postgres-ca.crt ./certs/tencentdb-postgres-ca.crt
USER node
EXPOSE 8080
CMD ["node", "dist/worker.js"]
