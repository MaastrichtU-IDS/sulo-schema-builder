# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/tsconfig.json frontend/vite.config.ts frontend/index.html \
     frontend/tailwind.config.js frontend/postcss.config.js ./
COPY frontend/src ./src
COPY frontend/public ./public

ARG VITE_API_BASE_URL=/api/v1
ARG VITE_SPARQL_ENDPOINT=/sparql
ARG VITE_AUTH_ENABLED=false
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_SPARQL_ENDPOINT=$VITE_SPARQL_ENDPOINT
ENV VITE_AUTH_ENABLED=$VITE_AUTH_ENABLED

RUN npm run build

# ── Stage 2: Nginx serving frontend + reverse-proxying API and SPARQL ────────
FROM nginx:alpine
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=frontend-builder /app/dist /usr/share/nginx/html
EXPOSE 80
