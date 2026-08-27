// Standard keycloak-js silent-check-sso page: this loads in a hidden iframe
// during Keycloak.init({ onLoad: 'check-sso' }) so the SPA can learn whether
// the visitor already has an SSO session, without redirecting them to the
// login page first.
//
// External file rather than an inline <script> in silent-check-sso.html
// itself: the app's CSP is script-src 'self' with no 'unsafe-inline', which
// silently blocks an inline script (keycloak.init()'s promise then never
// resolves — the exact same "stuck loading forever" symptom as the CSP gaps
// documented in api/src/plugins/helmet.ts). A same-origin external script is
// already covered by 'self'.
parent.postMessage(location.href, location.origin);
