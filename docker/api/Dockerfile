# ── Stage 1: Build React frontend ───────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY frontend/package.json ./frontend/
COPY packages/schema-core/package.json ./packages/schema-core/
RUN npm ci -w sulo-schema-builder-frontend -w @sulo/schema-core

COPY packages/schema-core/tsconfig.json ./packages/schema-core/
COPY packages/schema-core/src ./packages/schema-core/src
RUN npm run build -w @sulo/schema-core

COPY frontend/tsconfig.json frontend/vite.config.ts frontend/index.html \
     frontend/tailwind.config.js frontend/postcss.config.js ./frontend/
COPY frontend/src ./frontend/src
COPY frontend/public ./frontend/public

ARG VITE_API_BASE_URL=/api/v1
ARG VITE_AUTH_ENABLED=false
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_AUTH_ENABLED=$VITE_AUTH_ENABLED

RUN npm run build -w sulo-schema-builder-frontend

# ── Stage 2: Build API ───────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# better-sqlite3 is a native addon; build tools let npm compile it from source
# on Alpine/musl if no matching prebuilt binary is published.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json .npmrc ./
COPY api/package.json ./api/
COPY packages/schema-core/package.json ./packages/schema-core/
RUN npm ci -w sulo-schema-builder-api -w @sulo/schema-core

COPY packages/schema-core/tsconfig.json ./packages/schema-core/
COPY packages/schema-core/src ./packages/schema-core/src
RUN npm run build -w @sulo/schema-core

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
RUN npm ci -w sulo-schema-builder-api --omit=dev

COPY --from=builder /app/api/dist ./api/dist
COPY api/resources ./api/resources
# Plain .sql files, applied by dist/scripts/migrate.js (the compose `migrate`
# service) rather than by the server itself.
COPY api/migrations ./api/migrations
COPY --from=frontend-builder /app/frontend/dist ./api/public

EXPOSE 3000
CMD ["node", "api/dist/index.js"]

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
RUN npm ci -w sulo-schema-builder-api

COPY api/tsconfig.json ./api/
COPY api/src ./api/src
COPY api/resources ./api/resources
COPY api/migrations ./api/migrations
# Static build isn't hot-reloaded here — for frontend HMR, run
# `npm run dev` in frontend/ directly against this container's exposed port.
COPY --from=frontend-builder /app/frontend/dist ./api/public

EXPOSE 3000
CMD ["npm", "run", "dev", "-w", "sulo-schema-builder-api"]
