// Builds the Keycloak client instance from the server-reported auth config.
//
// The `url`/`realm` pair Keycloak needs is derived from the issuer
// (`GET /auth-config`'s `issuer`, e.g. "http://localhost:8088/realms/sulo")
// rather than from new VITE_* env vars: the server already knows the truth
// about its own Keycloak, and a second source of the same fact would drift.

import Keycloak from 'keycloak-js';
import type { AuthConfig } from '../api/authConfig.js';

/**
 * Parses an issuer URL of the form "<url>/realms/<realm>" (an optional
 * trailing slash is tolerated) into Keycloak's `url` and `realm` options.
 * Throws with a clear message if the shape doesn't match — a silent
 * misconfiguration here would otherwise surface as an inexplicable Keycloak
 * network error much later.
 */
export function parseIssuer(issuer: string): { url: string; realm: string } {
  const trimmed = issuer.trim().replace(/\/+$/, '');
  const marker = '/realms/';
  const markerIndex = trimmed.lastIndexOf(marker);

  if (markerIndex <= 0) {
    throw new Error(
      `Unexpected auth issuer shape (expected "<url>/realms/<realm>"): ${JSON.stringify(issuer)}`,
    );
  }

  const url = trimmed.slice(0, markerIndex);
  const realm = trimmed.slice(markerIndex + marker.length);

  if (!realm) {
    throw new Error(
      `Unexpected auth issuer shape (expected "<url>/realms/<realm>"): ${JSON.stringify(issuer)}`,
    );
  }

  return { url, realm };
}

export function createKeycloak(config: AuthConfig): Keycloak {
  if (!config.issuer) {
    throw new Error('Auth is enabled but the server reported no issuer.');
  }
  if (!config.clientId) {
    throw new Error('Auth is enabled but the server reported no clientId.');
  }

  const { url, realm } = parseIssuer(config.issuer);
  return new Keycloak({ url, realm, clientId: config.clientId });
}
