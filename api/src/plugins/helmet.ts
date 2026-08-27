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
        upgradeInsecureRequests: [],
      },
    },
  });
}, {
  name: 'helmet',
});
