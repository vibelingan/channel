# Dependency manifests only. This stage copies the whole repository, but all it
# emits is the lockfile, the workspace file and every package.json. The build
# stage copies FROM it, and Docker caches that copy by content, so editing any
# source file leaves those bytes identical and the install below stays cached.
# Copying everything before installing forced a full reinstall after every
# edit: 425 seconds for a cold ai-bff build, past the bundle check's limit.
FROM node:22.13.0-bookworm-slim AS manifests
WORKDIR /repo
COPY . .
RUN mkdir -p /manifests \
 && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /manifests/ \
 && find apps packages -name package.json -not -path '*/node_modules/*' \
      -exec cp --parents {} /manifests \;

FROM node:22.13.0-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.5.0
COPY --from=manifests /manifests/ ./
RUN pnpm install --frozen-lockfile
COPY . .
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
