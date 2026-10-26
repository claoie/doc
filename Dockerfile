FROM oven/bun:1.4.4 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json vite.config.ts ./
COPY src src

# Lint, typecheck and tests run as their own CI job; the image only builds.
RUN bun run build

FROM oven/bun:1.4.4-slim

WORKDIR /app

COPY --chown=bun:bun --from=builder /app/build ./build
RUN mkdir -p /app/data && chown bun:bun /app/data

USER bun

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_PATH=/app/data/storage

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://localhost:${process.env.PORT}/api/health`); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "build/server/bundle.js"]
