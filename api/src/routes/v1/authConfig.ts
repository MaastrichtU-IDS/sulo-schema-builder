// GET /auth-config — what the SPA needs before it can authenticate.
//
// One SPA build serves every deployment, so it cannot know at compile time
// whether it is talking to the multi-user web API or the single-user desktop
// sidecar. `enabled: false` means "no login UI, no bearer tokens" — the
// packaged desktop path.
//
// Public by design, and it must stay that way: a client that cannot read this
// cannot log in. It exposes only an issuer URL and a public client id — not
// secrets, and the browser is about to send both to Keycloak anyway.

import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config/index.js';

const authConfigRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/auth-config', async () => ({
    enabled: config.auth.enabled,
    issuer: config.auth.issuer,
    clientId: config.auth.clientId,
  }));
};

export default authConfigRoute;
