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

  it('throws in postgres mode when the issuer is missing', () => {
    expect(() => resolveAuthConfig({ AUTH_AUDIENCE: 'sulo-api' }, 'postgres')).toThrow(/AUTH_ISSUER/);
  });

  it('throws in postgres mode when the issuer is not a valid absolute URL', () => {
    expect(() => resolveAuthConfig({ ...BASE, AUTH_ISSUER: 'kc.example.org' }, 'postgres')).toThrow(/AUTH_ISSUER/);
  });

  it('throws in postgres mode when the audience is missing', () => {
    expect(() => resolveAuthConfig({ AUTH_ISSUER: BASE.AUTH_ISSUER }, 'postgres')).toThrow(/AUTH_AUDIENCE/);
  });

  it('accepts a local JWKS override for tests', () => {
    const cfg = resolveAuthConfig({ ...BASE, AUTH_JWKS_JSON: '{"keys":[]}' }, 'postgres');
    expect(cfg.jwksJson).toBe('{"keys":[]}');
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
});
