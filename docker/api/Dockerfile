# ── Stage 1: Build React frontend ───────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY frontend/package.json ./frontend/
# schema-core's sources come in *before* the install: its package.json has a
# `prepare` hook (`tsc`) so that a plain `npm ci` leaves dist/ — the only thing
# its main/types/exports point at — present for every consumer. The hook runs
# during install, so an install that could not see src/ would fail with
# TS18003. That costs a layer-cache hit whenever schema-core changes, which is
# rare, and buys one install path that behaves identically here, in CI, in
# release.yml and on a developer's clean clone.
COPY packages/schema-core/package.json packages/schema-core/tsconfig.json ./packages/schema-core/
COPY packages/schema-core/src ./packages/schema-core/src
RUN npm ci -w sulo-schema-builder-frontend -w @sulo/schema-core

COPY frontend/tsconfig.json frontend/vite.config.ts frontend/index.html \
     frontend/tailwind.config.js frontend/postcss.config.js ./frontend/
COPY frontend/src ./frontend/src
COPY frontend/public ./frontend/public

# Whether auth is required is discovered at runtime from GET /auth-config
# (see frontend/src/auth/AuthProvider.tsx) rather than baked in here — one
# SPA build then serves both the multi-user web deployment and the
# single-user desktop sidecar, and there's no second source of truth to
# drift from the server's own config.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build -w sulo-schema-builder-frontend

# ── Stage 2: Build API ───────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# better-sqlite3 is a native addon; build tools let npm compile it from source
# on Alpine/musl if no matching prebuilt binary is published.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json .npmrc ./
COPY api/package.json ./api/
# Sources before the install — see the frontend-builder stage above for why.
COPY packages/schema-core/package.json packages/schema-core/tsconfig.json ./packages/schema-core/
COPY packages/schema-core/src ./packages/schema-core/src
RUN npm ci -w sulo-schema-builder-api -w @sulo/schema-core

COPY api/tsconfig.json ./api/
COPY api/src ./api/src
RUN npm run build -w sulo-schema-builder-api

# ── Stage: ROBOT (shared reasoning toolchain) ─────────────────────────────────
# ROBOT bundles the OWLAPI + HermiT (full OWL DL), used by the /api/v1/reason
# endpoint for server-side consistency reasoning.
#
# Baking ROBOT and a JRE into the image is what keeps `isPackaged` false here,
# so the runtime download in api/src/services/robot.service.ts never engages —
# that path exists only for the packaged desktop app, which ships neither.
FROM node:22-alpine AS robot
ARG ROBOT_VERSION=1.9.7
RUN apk add --no-cache wget \
 && mkdir -p /opt/robot \
 && wget -qO /opt/robot/robot.jar \
      "https://github.com/ontodev/robot/releases/download/v${ROBOT_VERSION}/robot.jar" \
 && printf '#!/bin/sh\nexec java -Xmx2g -jar /opt/robot/robot.jar "$@"\n' > /usr/local/bin/robot \
 && chmod +x /usr/local/bin/robot

# ── Stage 3: Production ──────────────────────────────────────────────────────
# One process serves both the built React SPA and the REST API — no separate
# nginx container needed.
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
# The API binds loopback by default; in a container that would be unreachable
# from outside, so listen on all interfaces here.
ENV HOST=0.0.0.0
# Web deployments are multi-user: schemas live in Postgres (DATABASE_URL), not
# in the embedded SQLite file the desktop build uses.
ENV SCHEMA_STORAGE=postgres
# JRE + ROBOT for server-side OWL DL reasoning
RUN apk add --no-cache openjdk17-jre-headless python3 make g++
COPY --from=robot /opt/robot /opt/robot
COPY --from=robot /usr/local/bin/robot /usr/local/bin/robot

COPY --from=builder /app/package.json /app/package-lock.json /app/.npmrc ./
COPY --from=builder /app/api/package.json ./api/
# @sulo/schema-core is a workspace dependency (api/package.json declares it as
# "*"), so `npm ci` below symlinks node_modules/@sulo/schema-core straight to
# packages/schema-core — without this copy that directory does not exist in
# this stage and the symlink dangles, which builds clean and then fails at
# runtime with ERR_MODULE_NOT_FOUND the first time anything imports the
# package (plan-01 follow-up #6). `dist` (already built in the `builder`
# stage above) rather than `src`, because this stage runs `--omit=dev`: no
# typescript here for schema-core's own `prepare`/`tsc` to run against.
COPY --from=builder /app/packages/schema-core/package.json ./packages/schema-core/
COPY --from=builder /app/packages/schema-core/dist ./packages/schema-core/dist
# dist/ above is already built, but the manifest still carries the `prepare`
# (`tsc`) hook, and `npm ci` runs it for a local workspace dependency whether
# or not it was asked for by name. This stage has no typescript (--omit=dev)
# and no src/ to build from, so that hook must not run here — strip it rather
# than fight it.
RUN node -e "const fs=require('fs');const p='./packages/schema-core/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));delete j.scripts.prepare;fs.writeFileSync(p,JSON.stringify(j));"
RUN npm ci -w sulo-schema-builder-api --omit=dev

COPY --from=builder /app/api/dist ./api/dist
COPY api/resources ./api/resources
# Plain .sql files, applied by dist/scripts/migrate.js (the compose `migrate`
# service) rather than by the server itself.
COPY api/migrations ./api/migrations
COPY --from=frontend-builder /app/frontend/dist ./api/public

EXPOSE 3000
# --import, not a plain import inside index.js: OpenTelemetry's
# auto-instrumentation (src/instrumentation.ts) has to patch fastify/pg/http
# before this process ever imports them, and this flag is exactly what runs
# it first. A no-op — the SDK is never started — unless
# OTEL_EXPORTER_OTLP_ENDPOINT is set; see src/instrumentation.ts's own
# header for why this lives here rather than in index.ts, and why the
# packaged desktop binary (built from dist/index.js directly, never through
# this CMD) never sees it at all.
CMD ["node", "--import", "./api/dist/instrumentation.js", "api/dist/index.js"]

# ── Stage 4: Development (used by docker-compose.override.yml) ──────────────
FROM node:22-alpine AS development
WORKDIR /app
ENV NODE_ENV=development
ENV HOST=0.0.0.0
ENV SCHEMA_STORAGE=postgres

RUN apk add --no-cache openjdk17-jre-headless python3 make g++
COPY --from=robot /opt/robot /opt/robot
COPY --from=robot /usr/local/bin/robot /usr/local/bin/robot

COPY package.json package-lock.json .npmrc ./
COPY api/package.json ./api/
# Sources before the install, same reasoning as the frontend-builder stage's
# comment above: schema-core's `prepare` (`tsc`) needs src/ present to leave
# dist/ behind. @sulo/schema-core has to be named alongside the api workspace
# here — same as the builder/frontend-builder stages above — or its own
# lifecycle script never runs and the workspace symlink resolves to a
# package with no dist/, i.e. the same ERR_MODULE_NOT_FOUND the production
# stage's fix above exists to catch, just with a source dir instead of a
# missing one.
COPY packages/schema-core/package.json packages/schema-core/tsconfig.json ./packages/schema-core/
COPY packages/schema-core/src ./packages/schema-core/src
RUN npm ci -w sulo-schema-builder-api -w @sulo/schema-core

COPY api/tsconfig.json ./api/
COPY api/src ./api/src
COPY api/resources ./api/resources
COPY api/migrations ./api/migrations
# Static build isn't hot-reloaded here — for frontend HMR, run
# `npm run dev` in frontend/ directly against this container's exposed port.
COPY --from=frontend-builder /app/frontend/dist ./api/public

EXPOSE 3000
CMD ["npm", "run", "dev", "-w", "sulo-schema-builder-api"]
