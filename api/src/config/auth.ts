// Authentication configuration. Credentials live in Keycloak; this module only
// describes how to verify the tokens it issues.
//
// Fails fast in postgres mode: a web deployment that cannot verify a token
// must not start, because the alternative is serving an authenticated API with
// no authentication. Mirrors resolveStorage's strictness in ./server.ts.

export interface AuthConfig {
  enabled: boolean;
  issuer: string;
  audience: string;
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

export function resolveAuthConfig(env: Env, storage: 'postgres' | 'sqlite'): AuthConfig {
  const clientId = env.AUTH_CLIENT_ID?.trim() || 'sulo-spa';
  const userCacheTtlMs = parseInt(env.AUTH_USER_CACHE_TTL_MS?.trim() || '60000', 10);

  // The frozen desktop path is single-user and loopback-only: no issuer, no
  // token, no plugin (see server.ts). Nothing below is consulted there.
  if (storage !== 'postgres') {
    return {
      enabled: false,
      issuer: '', audience: '', jwksUri: '', jwksJson: null,
      clientId, userCacheTtlMs,
    };
  }

  const rawIssuer = required(env, 'AUTH_ISSUER');
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(rawIssuer);
  } catch {
    throw new Error(`AUTH_ISSUER must be an absolute URL (got ${JSON.stringify(rawIssuer)})`);
  }
  const issuer = issuerUrl.toString().replace(/\/+$/, '');

  return {
    enabled: true,
    issuer,
    audience: required(env, 'AUTH_AUDIENCE'),
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
    // Set only by tests: a literal JWKS avoids any network fetch. Never set in
    // a deployment — see the plan's global constraints.
    jwksJson: env.AUTH_JWKS_JSON?.trim() || null,
    clientId,
    userCacheTtlMs,
  };
}
