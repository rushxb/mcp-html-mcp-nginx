FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm run build
RUN pnpm prune --prod

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MCP_PORT=3000 \
    MCP_HOST=0.0.0.0 \
    MCP_DATA_DIR=/data \
    MCP_SITES_DIR=/sites

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN addgroup -S -g 10001 mcp && adduser -S -D -H -u 10001 -G mcp mcp \
  && mkdir -p /data /sites \
  && chown -R mcp:mcp /app /data /sites

USER mcp
EXPOSE 3000
CMD ["node", "dist/index.js"]
