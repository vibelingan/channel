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
RUN pnpm --filter @vibelingan-channel/ai-bff build
# pnpm refuses packages downloaded from a URL or git, but its legacy deploy
# applies that rule to the dependencies of EVERY workspace project, not just
# this service. The website's catalog importer takes SheetJS (xlsx) from
# SheetJS's own download address, which failed this build although none of it
# is installed here. The rule is off for this one command; the check after it
# fails the build instead if anything from a URL or git lands in the runtime.
RUN pnpm --filter @vibelingan-channel/ai-bff deploy --prod --legacy --config.block-exotic-subdeps=false /runtime \
 && if ls /runtime/node_modules/.pnpm | grep -E '@(https?|git)\+'; then \
      echo "a package downloaded from a URL or git would ship in the ai-bff runtime" >&2; \
      exit 1; \
    fi

FROM node:22.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/apps/ai-bff/dist ./dist
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
CMD ["node", "dist/server.js"]
