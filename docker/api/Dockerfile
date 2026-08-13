# ── Stage 1: Build React frontend ───────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/tsconfig.json frontend/vite.config.ts frontend/index.html \
     frontend/tailwind.config.js frontend/postcss.config.js ./
COPY frontend/src ./src
COPY frontend/public ./public

ARG VITE_API_BASE_URL=/api/v1
ARG VITE_AUTH_ENABLED=false
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_AUTH_ENABLED=$VITE_AUTH_ENABLED

RUN npm run build

# ── Stage 2: Build API ───────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# better-sqlite3 is a native addon; build tools let npm compile it from source
# on Alpine/musl if no matching prebuilt binary is published.
RUN apk add --no-cache python3 make g++

COPY api/package*.json ./
RUN npm ci

COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build

# ── Stage: ROBOT (shared reasoning toolchain) ─────────────────────────────────
# ROBOT bundles the OWLAPI + HermiT (full OWL DL), used by the /api/v1/reason
# endpoint for server-side consistency reasoning.
#
# Baking ROBOT and a JRE into the image is what keeps `isPackaged` false here,
# so the runtime download in api/src/services/robot.service.ts never engages —
# that path exists only for the packaged desktop app, which ships neither.
FROM node:20-alpine AS robot
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
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# JRE + ROBOT for server-side OWL DL reasoning
RUN apk add --no-cache openjdk17-jre-headless python3 make g++
COPY --from=robot /opt/robot /opt/robot
COPY --from=robot /usr/local/bin/robot /usr/local/bin/robot

COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY api/resources ./resources
COPY --from=frontend-builder /app/dist ./public

EXPOSE 3000
CMD ["node", "dist/index.js"]

# ── Stage 4: Development (used by docker-compose.override.yml) ──────────────
FROM node:20-alpine AS development
WORKDIR /app
ENV NODE_ENV=development

RUN apk add --no-cache openjdk17-jre-headless python3 make g++
COPY --from=robot /opt/robot /opt/robot
COPY --from=robot /usr/local/bin/robot /usr/local/bin/robot

COPY api/package*.json ./
RUN npm ci

COPY api/tsconfig.json ./
COPY api/src ./src
COPY api/resources ./resources
# Static build isn't hot-reloaded here — for frontend HMR, run
# `npm run dev` in frontend/ directly against this container's exposed port.
COPY --from=frontend-builder /app/dist ./public

EXPOSE 3000
CMD ["npm", "run", "dev"]
