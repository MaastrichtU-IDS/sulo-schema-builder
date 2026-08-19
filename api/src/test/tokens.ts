// Mints tokens the auth plugin will accept, without a Keycloak anywhere.
// The public JWKS is handed to the plugin through config.auth.jwksJson, so
// verification is fully offline.

import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export const TEST_ISSUER = 'https://kc.test.invalid/realms/sulo';
export const TEST_AUDIENCE = 'sulo-api';

export interface TestIssuer {
  issuer: string;
  audience: string;
  /** JSON Web Key Set, as the string config.auth.jwksJson expects. */
  jwks: string;
  sign(claims?: Record<string, unknown>, opts?: { issuer?: string; audience?: string; expiresIn?: string }): Promise<string>;
}

export async function createTestIssuer(): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  return {
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    jwks: JSON.stringify({ keys: [publicJwk] }),
    async sign(claims = {}, opts = {}) {
      return new SignJWT({ sub: 'kc-subject-1', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuedAt()
        .setIssuer(opts.issuer ?? TEST_ISSUER)
        .setAudience(opts.audience ?? TEST_AUDIENCE)
        .setExpirationTime(opts.expiresIn ?? '5m')
        .sign(privateKey);
    },
  };
}
