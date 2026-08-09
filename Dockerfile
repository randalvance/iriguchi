# syntax=docker/dockerfile:1
#
# Production image for the iriguchi gateway.
#
# Node runs the gateway's TypeScript sources directly by stripping types, so
# the gateway has no build stage and no compiled output to copy — only
# dependencies and src/. The management UI is the one exception: it is a
# separate package with a real build, done in its own stage below so that
# neither its toolchain nor its sources reach the runtime layer.
#
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-slim AS ui
WORKDIR /app/ui
# Built here rather than copied from the host: a host build would be whatever
# the developer last ran, silently shipping stale assets. .dockerignore keeps
# ui/dist and ui/node_modules out of the context for the same reason.
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM node:26-slim AS runtime
WORKDIR /app

# Defaults only. Credentials (IRI_API_KEY, IRI_REGISTRATION_SECRET, and the
# IRI_PROVIDER_* triples) are supplied at run time — loadConfig() fails loudly
# at startup if they are missing, which is the intended behavior.
# IRI_UI_ENABLED is deliberately absent, which means the default (false)
# applies: the image publishes port 4000, and an unauthenticated /internal/*
# surface appearing there without being asked for would be the image choosing
# an exposure on the operator's behalf.
ENV NODE_ENV=production \
    IRI_PORT=4000 \
    IRI_DB_PATH=/data/iriguchi.db \
    IRI_TMP_DIR=/tmp/iri \
    IRI_UI_DIST=/app/ui/dist

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Built assets only — no ui/src, no ui/node_modules, no bundler.
COPY --from=ui /app/ui/dist ./ui/dist

# /data holds the SQLite registry and its -wal/-shm siblings; /tmp/iri is
# disposable scratch for materialized agent skills. Both must be writable by
# the unprivileged user the container runs as.
RUN mkdir -p /data /tmp/iri && chown -R node:node /data /tmp/iri
VOLUME /data

EXPOSE 4000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.IRI_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.ts"]
