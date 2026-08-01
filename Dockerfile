# syntax=docker/dockerfile:1
#
# Production image for the iriguchi gateway.
#
# Node runs the TypeScript sources directly by stripping types, so there is no
# build stage and no compiled output to copy — only dependencies and src/.
#
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-slim AS runtime
WORKDIR /app

# Defaults only. Credentials (IRI_API_KEY, IRI_REGISTRATION_SECRET, and the
# IRI_PROVIDER_* triples) are supplied at run time — loadConfig() fails loudly
# at startup if they are missing, which is the intended behavior.
ENV NODE_ENV=production \
    IRI_PORT=4000 \
    IRI_DB_PATH=/data/iriguchi.db \
    IRI_TMP_DIR=/tmp/iri

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

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
