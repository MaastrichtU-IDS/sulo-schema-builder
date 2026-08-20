// Authentication configuration. Credentials live in Keycloak; this module only
// describes how to verify the tokens it issues.
//
// Fails fast in postgres mode: a web deployment that cannot verify a token
// must not start, because the alternative is serving an authenticated API with
// no authentication. Mirrors resolveStorage's strictness in ./server.ts.

export interface AuthConfig {
  enabled: boolean;
  /** Expected `iss` claim. The URL the *browser* reached Keycloak on. */
  issuer: string;
  audience: string;
  /**
   * Where *this server* fetches the signing keys. Defaults to the standard path
   * under `issuer`, but is separately settable because the two are not the same
   * address in a container deployment — see the comment at its assignment below.
   */
  jwksUri: string;
  jwksJson: string | null;
  clientId: string;
  userCacheTtlMs: number;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when SCHEMA_STORAGE=postgres (authentication cannot be verified without it)`);
  }
  return value;
}

// parseInt(..., 10) alone silently accepts garbage: parseInt('60s', 10) is
// 60, and parseInt('abc', 10) is NaN, which then flows into a cache
// comparison (`Date.now() - cached.at < NaN`) that is always false — a cache
// that never hits, with no error and no log line to explain it. Validate
// fully instead: an unset value takes the fallback, anything else must be a
// finite positive number, and anything else throws in the same style as
// required() above.
/**
 * Same fail-fast treatment as required(), for the values that must be URLs: a
 * URL-shaped setting that is not a URL is a misconfiguration, and left
 * unchecked it surfaces much later as "every request is a 401".
 */
function absoluteUrl(name: string, raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL (got ${JSON.stringify(raw)})`);
  }
}

function positiveIntOrDefault(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds (got ${JSON.stringify(raw)})`);
  }
  return value;
}

export function resolveAuthConfig(env: Env, storage: 'postgres' | 'sqlite'): AuthConfig {
  const clientId = env.AUTH_CLIENT_ID?.trim() || 'sulo-spa';
  const userCacheTtlMs = positiveIntOrDefault(env, 'AUTH_USER_CACHE_TTL_MS', 60_000);

  // The frozen desktop path is single-user and loopback-only: no issuer, no
  // token, no plugin (see server.ts). Nothing below is consulted there.
  if (storage !== 'postgres') {
    return {
      enabled: false,
      issuer: '', audience: '', jwksUri: '', jwksJson: null,
      clientId, userCacheTtlMs,
    };
  }

  const issuer = absoluteUrl('AUTH_ISSUER', required(env, 'AUTH_ISSUER'))
    .toString().replace(/\/+$/, '');

  // The `iss` claim and the JWKS fetch are two different addresses, and deriving
  // the second from the first broke the Docker deployment outright.
  //
  // Keycloak stamps every token's `iss` with the hostname the *browser* used
  // (KC_HOSTNAME; with Keycloak 26's hostname-backchannel-dynamic defaulting to
  // false it does so unconditionally), so AUTH_ISSUER has to be the public,
  // browser-facing URL — `http://localhost:8088/realms/sulo` in compose, an
  // ingress hostname in a cluster. Fetching the signing keys, on the other hand,
  // is a server-to-server call from inside the network, where that public URL is
  // wrong or unroutable: in compose, `localhost:8088` inside the api container is
  // that container's own loopback, so the fetch simply fails and *every* token is
  // rejected with a 401. The fetch must use in-network addressing —
  // `http://keycloak:8080/...` in compose, `http://keycloak.sulo.svc:8080/...`
  // in Kubernetes — which is what this override is for.
  //
  // Defaults to the derivation, so single-host deployments (and every test that
  // predates this) need not set it.
  const rawJwksUri = env.AUTH_JWKS_URI?.trim();
  const jwksUri = rawJwksUri
    ? absoluteUrl('AUTH_JWKS_URI', rawJwksUri).toString()
    : `${issuer}/protocol/openid-connect/certs`;

  return {
    enabled: true,
    issuer,
    audience: required(env, 'AUTH_AUDIENCE'),
    jwksUri,
    // Set only by tests: a literal JWKS avoids any network fetch. Never set in
    // a deployment — see the plan's global constraints.
    jwksJson: env.AUTH_JWKS_JSON?.trim() || null,
    clientId,
    userCacheTtlMs,
  };
}
