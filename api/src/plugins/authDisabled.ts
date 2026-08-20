// The no-op half of the auth surface: same decorators, no authentication.
// Registered in place of plugins/auth.ts for the frozen SQLite desktop path
// (see the storage branch in ../server.ts).
//
// WHY THIS EXISTS. `authRequired` and `requireRole` are decorators
// plugins/auth.ts provides, and that plugin is registered only in postgres mode
// — it verifies JWTs with `jose`, which must not enter the packaged binary's
// import graph. But `{ preHandler: fastify.authRequired }` is evaluated when a
// route registers, so in sqlite mode the value would be `undefined` and Fastify
// would refuse the route at boot. The alternatives were:
//
//   1. `config.auth.enabled ? fastify.authRequired : undefined` at every call
//      site — about fifteen of them across three route files, i.e. fifteen
//      chances for the two modes to drift apart, and a reviewer can no longer
//      tell from a route whether it is guarded.
//   2. Guard once, here. Route files then read identically in both modes and the
//      mode is decided in exactly one place, ../server.ts.
//
// Permissive is the correct behaviour for this mode, not a shortcut: the
// packaged desktop app is single-user, binds to loopback, has no issuer, no
// login UI and no token to present. There is nobody to authenticate, and
// `config.auth.enabled` is false there by construction (config/auth.ts).
// The postgres-mode schema routes are never registered alongside this plugin
// (routes/v1/index.ts mounts the SQLite routes instead), so nothing that reads
// `request.user` runs behind these no-ops.
//
// This file must stay free of any import that reaches `jose` — including a type
// import of ./auth.js, whose `declare module 'fastify'` augmentation is global
// to the program and so needs no import here. It is in the packaged binary's
// static graph, which is the entire reason it exists.
//
// config/index.js is safe to import here: its transitive imports (server.ts,
// db.ts, rdf.ts, reasoner.ts, config/auth.ts) never reach plugins/auth.ts or
// `jose` — only test/tokens.ts and plugins/auth.ts do, and neither is in this
// file's import graph.

import fp from 'fastify-plugin';
import { config } from '../config/index.js';

export default fp(async (fastify) => {
  // Registering both plugins throws FST_ERR_DEC_ALREADY_PRESENT today (they
  // both decorate `authRequired`/`requireRole`), so this branch is not
  // currently reachable — but it is one edit away, and the failure mode is
  // silently disabling authentication on a web deployment. Assert it can
  // never happen instead of relying on that accident of registration order.
  if (config.auth.enabled) {
    throw new Error('authDisabled registered while auth is enabled — use plugins/auth.ts');
  }
  fastify.decorateRequest('user', null);
  fastify.decorate('authRequired', async () => { /* single-user mode: nobody to authenticate */ });
  fastify.decorate('requireRole', () => async () => { /* single-user mode: no roles to check */ });
}, { name: 'auth-disabled' });
