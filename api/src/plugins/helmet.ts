// CSP was disabled outright with a stale rationale (Swagger UI, which this
// repo has never shipped) while the SPA was served to arbitrary visitors —
// plan-01 follow-up #4.
//
// The directives below are @fastify/helmet's own current defaults, written
// out explicitly rather than pulled from `helmet.contentSecurityPolicy.
// getDefaultDirectives()` — that function lives on the `helmet` package
// nested under `@fastify/helmet`'s own node_modules, not something this
// package depends on directly, and a future @fastify/helmet upgrade
// silently changing what "default" means is exactly the kind of behavior
// drift a CSP should not inherit implicitly. The one addition to the
// defaults are two additions, both driven by the same fact: keycloak-js
// talks to AUTH_ISSUER's own origin directly from the browser, not just
// through same-origin requests.
//
//   - connect-src: the code→token exchange and silent refresh are background
//     fetch/XHR calls to that origin.
//   - frame-src: keycloak-js's `init()` also opens a hidden iframe at that
//     origin (.../protocol/openid-connect/3p-cookies/step1.html) as part of
//     its third-party-cookie/silent-SSO check. Without an explicit
//     frame-src, it falls back to default-src 'self' and silently blocks
//     that iframe's content from loading — keycloak.init()'s promise then
//     never resolves, AuthProvider stays at 'loading' forever, and
//     UserMenu (which renders null while loading) makes the entire nav bar
//     look like the desktop build with no visible error anywhere. Caught by
//     actually driving a sign-in through a browser against this exact CSP,
//     not by reasoning about the policy in the abstract.
//
// `upgradeInsecureRequests` is deliberately OMITTED (it's in @fastify/
// helmet's own defaults). This app is served plain HTTP directly to the
// browser in every environment that has actually been tested (local
// docker-compose, CI), and CSP's 'self' is scheme-sensitive to whatever the
// browser's address bar shows. With the directive present, Chrome silently
// rewrites the silent-check-sso iframe's http:// redirect target to https://
// before checking it against frame-src — which then matches neither 'self'
// (wrong scheme) nor the Keycloak origin (wrong scheme AND host), and the
// navigation is blocked with net::ERR_BLOCKED_BY_CSP. keycloak.init() then
// hangs forever, identical symptom to the missing-frame-src bug above. Since
// this SPA never hardcodes an absolute http:// URL for its own resources
// (Vite emits same-origin relative paths), the directive's actual
// mixed-content protection here is negligible — not worth reintroducing this
// failure mode for a deployment that terminates TLS at a reverse proxy in
// front of a plain-HTTP origin.
import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import type { AuthConfig } from '../config/auth.js';

export interface HelmetPluginOptions {
  auth: AuthConfig;
}

export default fp<HelmetPluginOptions>(async (fastify, opts) => {
  // Desktop/sqlite mode has no issuer at all (auth.enabled is false there) —
  // both stay 'self'-only, which is correct: the packaged binary never talks
  // to an external identity provider.
  const keycloakOrigin = opts.auth.enabled && opts.auth.issuer ? new URL(opts.auth.issuer).origin : null;
  const connectSrc = ["'self'", ...(keycloakOrigin ? [keycloakOrigin] : [])];
  const frameSrc = ["'self'", ...(keycloakOrigin ? [keycloakOrigin] : [])];

  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc,
        fontSrc: ["'self'", 'https:', 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        frameSrc,
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
        // Omitting this key would NOT remove it — @fastify/helmet merges
        // unspecified directives with its own defaults, which include this
        // one. `null` is the explicit opt-out (this package's types don't
        // accept `false` here, unlike plain `helmet`).
        upgradeInsecureRequests: null,
      },
    },
  });
}, {
  name: 'helmet',
});
