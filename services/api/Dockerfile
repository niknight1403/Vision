# Build stage: the complete workspace is available only while compiling.
FROM node:22-bookworm-slim AS build
ENV NODE_ENV=development
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/mobile/package.json apps/mobile/package.json
COPY services/api/package.json services/api/package.json
COPY packages/trading-core/package.json packages/trading-core/package.json
RUN npm ci --include=dev
COPY . .
RUN npm run build --workspace @autonomagent/trading-core \
    && npx prisma generate --schema services/api/prisma/schema.prisma \
    && npm run build --workspace @autonomagent/api

# A separate one-shot image deliberately retains the Prisma CLI for migrations.
# It is not the long-running API/worker runtime image.
FROM build AS migrate
ENV NODE_ENV=production
CMD ["npx", "prisma", "migrate", "deploy", "--schema", "services/api/prisma/schema.prisma"]

# Install only production dependencies of the API and trading-core workspaces.
# Omit optional peer packages: Prisma declares its CLI and TypeScript as optional
# peers, and neither is needed by the generated Prisma Client at runtime.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/mobile/package.json apps/mobile/package.json
COPY services/api/package.json services/api/package.json
COPY packages/trading-core/package.json packages/trading-core/package.json
RUN npm ci --omit=dev --omit=peer --workspace @autonomagent/api --workspace @autonomagent/trading-core --include-workspace-root=false \
    && rm -rf node_modules/@autonomagent/mobile \
    && npm cache clean --force
COPY --from=build /workspace/dist/services/api ./dist/services/api
COPY --from=build /workspace/packages/trading-core/dist ./packages/trading-core/dist
COPY --from=build /workspace/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /workspace/services/api/prisma ./services/api/prisma
LABEL org.opencontainers.image.title="Vision API" \
      org.opencontainers.image.description="Minimal production runtime for Vision API and agent worker"
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/services/api/src/server.js"]
