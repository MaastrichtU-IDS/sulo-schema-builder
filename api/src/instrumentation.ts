// OpenTelemetry bootstrap for the web deployment — preloaded via
// `node --import ./dist/instrumentation.js dist/index.js`
// (docker/api/Dockerfile's production CMD), never imported from index.ts
// itself.
//
// That split matters for two reasons:
//
//  1. Auto-instrumentation works by patching Node's module loader before the
//     instrumented modules (fastify, pg, http, dns, ...) are first imported.
//     A side-effecting top-level import inside index.ts would already be too
//     late for anything index.ts itself pulls in above it; `--import` runs
//     this file, and its NodeSDK.start() call, before dist/index.js begins
//     loading at all.
//  2. This file is never on `dist/index.js`'s own static import graph, so
//     the packaged desktop binary (`pkg dist/index.js` — see
//     scripts/package-desktop.mjs) never sees it, never bundles the ~230
//     packages `@opentelemetry/auto-instrumentations-node` pulls in, and
//     pkg's snapshot mechanism is never asked to cope with runtime
//     require-hooking (auto-instrumentation's own technique, and exactly
//     the class of thing pkg has repeatedly failed to snapshot elsewhere in
//     this codebase — see the kysely/jose import-type banners throughout
//     modules/*/repo.ts). Desktop mode needs none of this: it is
//     single-user and loopback-bound, with no cluster to observe it from.
//
// A no-op — the SDK is never started — unless OTEL_EXPORTER_OTLP_ENDPOINT is
// set. Every other setting (OTEL_SERVICE_NAME, OTEL_TRACES_SAMPLER,
// OTEL_EXPORTER_OTLP_HEADERS, ...) is read directly by the SDK/exporter from
// the environment using OpenTelemetry's own standard variable names — see
// https://opentelemetry.io/docs/languages/sdk-configuration/ — so a
// deployment's collector endpoint is the only thing this file itself needs
// to know about.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

if (endpoint) {
  const sdk = new NodeSDK({
    // Merged with the SDK's own default resource (process/telemetry.sdk.*
    // attributes), per @opentelemetry/sdk-node's own recommendation — a bare
    // resourceFromAttributes(...) here would replace those defaults rather
    // than add to them.
    resource: defaultResource().merge(resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME?.trim() || 'sulo-schema-builder-api',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? 'unknown',
    })),
    traceExporter: new OTLPTraceExporter(),
    // fs instrumentation is extremely noisy (every migration/resource read
    // becomes a span) and adds little a request-scoped trace needs; every
    // other auto-instrumentation (http, fastify, pg, dns, undici) stays on.
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  });

  sdk.start();

  // Fastify's own close-listeners handle the HTTP server; this is the one
  // thing outside that lifecycle that also needs a clean shutdown, so
  // buffered spans flush instead of being dropped on a container stop.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      sdk.shutdown().finally(() => process.exit(0));
    });
  }
} else {
  console.log('[otel] OTEL_EXPORTER_OTLP_ENDPOINT is unset — tracing disabled');
}
