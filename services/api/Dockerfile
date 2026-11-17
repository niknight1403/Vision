FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/mobile/package.json apps/mobile/package.json
COPY services/api/package.json services/api/package.json
COPY packages/trading-core/package.json packages/trading-core/package.json
# Prisma CLI and TypeScript are build tools declared in workspace devDependencies.
# Include them explicitly because NODE_ENV=production otherwise makes npm ci omit them.
RUN npm ci --include=dev
COPY . .
RUN npx prisma generate --schema services/api/prisma/schema.prisma \
    && npm run build --workspace @autonomagent/api
WORKDIR /workspace
CMD ["npm", "run", "start:migrate", "--workspace", "@autonomagent/api"]
