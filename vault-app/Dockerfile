# vault-app HTTP BFF image.
#
# Build from the repository root (needs vault/001_schema.sql next to vault-app):
#   docker build -f vault-app/Dockerfile .
#
# Runs: node src/server.js --http
# Listens: 0.0.0.0:$PORT (default 8787)
# Secrets: none in this file. Set DATABASE_URL at runtime on the host.

FROM node:22-alpine

WORKDIR /app

# Phase 1 + FTS + noticed + return. Never copy vault/002_rls_plan.sql — RLS stays off.
COPY vault/001_schema.sql /app/vault/001_schema.sql
COPY vault/003_fts.sql /app/vault/003_fts.sql
COPY vault/004_noticed.sql /app/vault/004_noticed.sql
COPY vault/005_return.sql /app/vault/005_return.sql
COPY vault/006_progress.sql /app/vault/006_progress.sql
COPY vault/007_cold_ask.sql /app/vault/007_cold_ask.sql
COPY vault/008_drafts.sql /app/vault/008_drafts.sql
COPY vault/009_draft_grade.sql /app/vault/009_draft_grade.sql

WORKDIR /app/vault-app
COPY vault-app/package.json vault-app/package-lock.json ./
RUN npm ci --omit=dev

COPY vault-app/src ./src
COPY vault-app/public ./public
COPY vault-app/FIXED_VENT.md ./FIXED_VENT.md

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Same as `npm run serve` / `npm run serve -- --http`.
CMD ["node", "src/server.js", "--http"]
