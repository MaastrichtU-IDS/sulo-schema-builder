import { describe, it, expect } from 'vitest';
import { resolveAuthConfig } from './auth.js';

const BASE = { AUTH_ISSUER: 'https://kc.example.org/realms/sulo', AUTH_AUDIENCE: 'sulo-api' };

describe('resolveAuthConfig', () => {
  it('is disabled and permissive in sqlite mode', () => {
    const cfg = resolveAuthConfig({}, 'sqlite');
    expect(cfg.enabled).toBe(false);
  });

  it('derives the JWKS URI from the issuer', () => {
    const cfg = resolveAuthConfig(BASE, 'postgres');
    expect(cfg.enabled).toBe(true);
    expect(cfg.issuer).toBe('https://kc.example.org/realms/sulo');
    expect(cfg.jwksUri).toBe('https://kc.example.org/realms/sulo/protocol/openid-connect/certs');
    expect(cfg.audience).toBe('sulo-api');
    expect(cfg.jwksJson).toBeNull();
  });

  it('strips a trailing slash from the issuer before deriving the JWKS URI', () => {
    const cfg = resolveAuthConfig({ ...BASE, AUTH_ISSUER: 'https://kc.example.org/realms/sulo/' }, 'postgres');
    expect(cfg.jwksUri).toBe('https://kc.example.org/realms/sulo/protocol/openid-connect/certs');
  });

  // The issuer (`iss`, checked against the browser-facing URL) and the JWKS
  // fetch address (a server-to-server call) are not the same thing in a
  // container deployment — see the comment above resolveAuthConfig's
  // AUTH_JWKS_URI handling. These three cases are what would have caught that
  // coupling before it shipped.
  it('honours an explicit AUTH_JWKS_URI override instead of deriving one from the issuer', () => {
    const cfg = resolveAuthConfig(
      { ...BASE, AUTH_JWKS_URI: 'http://keycloak:8080/realms/sulo/protocol/openid-connect/certs' },
      'postgres',
    );
    expect(cfg.jwksUri).toBe('http://keycloak:8080/realms/sulo/protocol/openid-connect/certs');
    // Independent of the issuer: the override does not have to share a host,
    // port, or even scheme with AUTH_ISSUER.
    expect(cfg.issuer).toBe('https://kc.example.org/realms/sulo');
  });

  it('derives the JWKS URI from the issuer when AUTH_JWKS_URI is unset', () => {
    const cfg = resolveAuthConfig(BASE, 'postgres');
    expect(cfg.jwksUri).toBe('https://kc.example.org/realms/sulo/protocol/openid-connect/certs');
  });

  it('rejects a malformed AUTH_JWKS_URI, naming the variable', () => {
    expect(() => resolveAuthConfig({ ...BASE, AUTH_JWKS_URI: 'not-a-url' }, 'postgres')).toThrow(/AUTH_JWKS_URI/);
  });

  it('throws in postgres mode when the issuer is missing', () => {
    expect(() => resolveAuthConfig({ AUTH_AUDIENCE: 'sulo-api' }, 'postgres')).toThrow(/AUTH_ISSUER/);
  });

  it('throws in postgres mode when the issuer is not a valid absolute URL', () => {
    expect(() => resolveAuthConfig({ ...BASE, AUTH_ISSUER: 'kc.example.org' }, 'postgres')).toThrow(/AUTH_ISSUER/);
  });

  it('throws in postgres mode when the audience is missing', () => {
    expect(() => resolveAuthConfig({ AUTH_ISSUER: BASE.AUTH_ISSUER }, 'postgres')).toThrow(/AUTH_AUDIENCE/);
  });

  it('accepts a local JWKS override when NODE_ENV is test', () => {
    const cfg = resolveAuthConfig({ ...BASE, AUTH_JWKS_JSON: '{"keys":[]}', NODE_ENV: 'test' }, 'postgres');
    expect(cfg.jwksJson).toBe('{"keys":[]}');
  });

  // Fix for: AUTH_JWKS_JSON is documented as test-only but nothing enforced
  // that, and it's one of the few auth variables compose doesn't pin — so a
  // `.env` copied from a test stanza could silently replace the trust anchor
  // in a real deployment (any sub/iss/aud its holder chose to sign, no log
  // line). Enforced here rather than just documented.
  it('rejects AUTH_JWKS_JSON when NODE_ENV is not test', () => {
    expect(() =>
      resolveAuthConfig({ ...BASE, AUTH_JWKS_JSON: '{"keys":[]}' }, 'postgres'),
    ).toThrow(/AUTH_JWKS_JSON/);
    expect(() =>
      resolveAuthConfig({ ...BASE, AUTH_JWKS_JSON: '{"keys":[]}', NODE_ENV: 'production' }, 'postgres'),
    ).toThrow(/AUTH_JWKS_JSON/);
  });

  it('defaults the user cache TTL to 60000ms when unset', () => {
    const cfg = resolveAuthConfig(BASE, 'postgres');
    expect(cfg.userCacheTtlMs).toBe(60_000);
  });

  it('honours a valid numeric AUTH_USER_CACHE_TTL_MS', () => {
    const cfg = resolveAuthConfig({ ...BASE, AUTH_USER_CACHE_TTL_MS: '120000' }, 'postgres');
    expect(cfg.userCacheTtlMs).toBe(120_000);
  });

  it('throws when AUTH_USER_CACHE_TTL_MS is not numeric', () => {
    expect(() => resolveAuthConfig({ ...BASE, AUTH_USER_CACHE_TTL_MS: '60s' }, 'postgres')).toThrow(
      /AUTH_USER_CACHE_TTL_MS/,
    );
  });

  it('throws when AUTH_USER_CACHE_TTL_MS is negative or zero', () => {
    expect(() => resolveAuthConfig({ ...BASE, AUTH_USER_CACHE_TTL_MS: '-1' }, 'postgres')).toThrow(
      /AUTH_USER_CACHE_TTL_MS/,
    );
    expect(() => resolveAuthConfig({ ...BASE, AUTH_USER_CACHE_TTL_MS: '0' }, 'postgres')).toThrow(
      /AUTH_USER_CACHE_TTL_MS/,
    );
  });

  // Fix for: the boot-time JWKS pre-fetch (plugins/auth.ts) turning any
  // Keycloak outage into a total API outage, with no way for a Kubernetes
  // deployment (no docker-compose depends_on equivalent) to opt out.
  describe('AUTH_REQUIRE_JWKS_AT_BOOT', () => {
    it('defaults to true, preserving the loud fail-fast boot behaviour', () => {
      const cfg = resolveAuthConfig(BASE, 'postgres');
      expect(cfg.requireJwksAtBoot).toBe(true);
    });

    it('is true in sqlite mode too, though nothing consults it there', () => {
      const cfg = resolveAuthConfig({}, 'sqlite');
      expect(cfg.requireJwksAtBoot).toBe(true);
    });

    it('honours an explicit "false"', () => {
      const cfg = resolveAuthConfig({ ...BASE, AUTH_REQUIRE_JWKS_AT_BOOT: 'false' }, 'postgres');
      expect(cfg.requireJwksAtBoot).toBe(false);
    });

    it('honours an explicit "true"', () => {
      const cfg = resolveAuthConfig({ ...BASE, AUTH_REQUIRE_JWKS_AT_BOOT: 'true' }, 'postgres');
      expect(cfg.requireJwksAtBoot).toBe(true);
    });

    it('rejects anything other than "true"/"false"', () => {
      expect(() =>
        resolveAuthConfig({ ...BASE, AUTH_REQUIRE_JWKS_AT_BOOT: 'yes' }, 'postgres'),
      ).toThrow(/AUTH_REQUIRE_JWKS_AT_BOOT/);
    });
  });

  // modules/users/service.ts's withGroupAdminOverride is a no-op whenever
  // this is null — the default a deployment that has never heard of
  // AUTH_ADMIN_GROUP gets, in both storage modes.
  describe('AUTH_ADMIN_GROUP', () => {
    it('defaults to null', () => {
      expect(resolveAuthConfig(BASE, 'postgres').adminGroup).toBeNull();
      expect(resolveAuthConfig({}, 'sqlite').adminGroup).toBeNull();
    });

    it('honours an explicit group name', () => {
      const cfg = resolveAuthConfig({ ...BASE, AUTH_ADMIN_GROUP: 'admins' }, 'postgres');
      expect(cfg.adminGroup).toBe('admins');
    });

    it('trims whitespace and treats an empty/whitespace-only value as unset', () => {
      expect(resolveAuthConfig({ ...BASE, AUTH_ADMIN_GROUP: '  admins  ' }, 'postgres').adminGroup).toBe('admins');
      expect(resolveAuthConfig({ ...BASE, AUTH_ADMIN_GROUP: '   ' }, 'postgres').adminGroup).toBeNull();
    });
  });
});
