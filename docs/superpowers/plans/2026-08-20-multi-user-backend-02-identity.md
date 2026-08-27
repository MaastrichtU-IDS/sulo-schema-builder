# Multi-user Backend — Plan 2: Identity (Keycloak-delegated authentication)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every request to the Postgres deployment carries a verified identity, schemas belong to the user who created them, and login/registration/ORCID/GitHub sign-in are handled by a Keycloak container rather than credential code in this repo.

**Architecture:** A Keycloak service owns credentials and social brokering; its realm is committed as an importable JSON export. The API verifies bearer JWTs against Keycloak's JWKS with `jose`, JIT-provisions a mirror row in `users`, and exposes `request.user` plus `authRequired`/`requireRole` guards. `LOCAL_OWNER_ID` stops being the owner of everything: schema routes key on `request.user.id`, so list/read/write are naturally owner-scoped. The SPA uses `keycloak-js` with authorization-code + PKCE, holds the access token in memory, and attaches it through the existing axios client. The frozen SQLite desktop path stays authentication-free — one SPA build serves both, told which mode it is in by a new `GET /api/v1/auth-config`.

**Scope boundary:** this plan does NOT add visibility, grants, roles-in-anger, or anonymous public reads — every schema route requires a session here, and plan 3 opens read access up through the ACL. Do not build quotas, the reasoning queue, SSE or admin routes.

**Tech Stack:** Keycloak 26 (`quay.io/keycloak/keycloak`), `jose`, Fastify 5, Kysely, Postgres 16, `keycloak-js`, vitest 2, Playwright, `@testcontainers/postgresql`.

**Spec:** `docs/superpowers/specs/2026-08-19-multi-user-backend-design.md` — sections 4 (Authentication) and, for the `users` table, section 3. Section 5 (Authorization) is plan 3; only the two clauses named in Task 3 are pulled forward.

**Predecessor:** `docs/superpowers/plans/2026-08-19-multi-user-backend-01-foundation.md` (complete). Its residuals are catalogued in `docs/superpowers/plans/2026-08-20-plan-01-followups.md` — item 5 (the UI clear) and item 6 (the dangling `@sulo/schema-core` symlink in the production image) are the two this plan may collide with; neither is in scope here.

## Global Constraints

- Node 22; TypeScript strict, NodeNext ESM — **every relative import ends in `.js`**.
- Postgres accessed only through Kysely. Migrations are plain `.sql` in `api/migrations/`, named `NNN_description.sql`, never edited once applied.
- **The packaged desktop binary must keep building AND booting.** `kysely` and `pg` cannot be snapshotted by pkg, which is why `plugins/pg.js` is loaded through `await import()` while the SQLite plugin is static, and why `api/src/modules/schemas/{repo,service}.ts` import kysely as `import type` only. `jose` and any new runtime dependency reachable from `dist/index.js` in **sqlite** mode must be verified against a packaged build, not just against tests. Read `api/src/pkgDirname.ts` and `api/src/paths.ts` first.
- Authentication is active only when `config.storage === 'postgres'`. In `sqlite` mode no auth plugin is registered, no token is required, and the desktop app behaves exactly as it does today.
- `config.auth` must fail fast: in postgres mode a missing issuer or audience is a startup error, not a silent default. Follow the precedent in `api/src/config/server.ts`'s `resolveStorage`.
- Tests never require a running Keycloak. A `jose`-generated keypair signs tokens and `AUTH_JWKS_JSON` + `AUTH_ISSUER` override the config. **No dev-bypass header, query parameter or env flag may exist in production code paths.**
- Access tokens are validated on `iss`, `aud`, `exp`/`nbf` (5s clock tolerance) and signature. `sub` is the identity; never trust `email` as a key.
- The seeded row `LOCAL_OWNER_ID` (`00000000-…-0001`, subject `'local'`) stays in the database and becomes an ordinary record. **`'local'` must never be a value Keycloak can issue as `sub`** — assert this in code, not just in a comment.
- Do not modify `api/src/rdf/safeFetch.ts`, `api/src/rdf/guardedUpperConcepts.ts`, `services/robot.service.ts`, `services/sulo.service.ts`, the ROBOT parsers, or anything under `api/src/legacy/`.
- Do not restructure `frontend/src/pages/OntologyBuilderPage.tsx` (4065 lines). Import changes and the small hook additions Task 4 names are allowed; nothing else.
- Commit after every task. Never `git commit` outside the steps that say to; never push, open a PR, or amend an existing commit.

---

### Task 1: Keycloak service, committed realm, and `config/auth.ts`

**Files:**
- Create: `docker/keycloak/realm-sulo.json`, `docker/keycloak/configure-idps.sh`, `api/src/config/auth.ts`, `api/src/config/auth.test.ts`
- Modify: `api/src/config/index.ts`, `api/src/config/env.ts` (only if a helper is missing), `docker-compose.yml`, `README.md`, `.env.example` (create if Task 1 of the follow-ups list did not)
- Test: `api/src/config/auth.test.ts`

**Interfaces:**
- Consumes: `optional()`/env helpers from `api/src/config/env.ts`; `storage` from `api/src/config/server.ts`.
- Produces: `resolveAuthConfig(env, storage)` (pure, exported for tests) and `authConfig`, shaped:
  ```ts
  {
    enabled: boolean;          // storage === 'postgres'
    issuer: string;            // e.g. http://localhost:8088/realms/sulo
    audience: string;          // 'sulo-api'
    jwksUri: string;           // derived: `${issuer}/protocol/openid-connect/certs`
    jwksJson: string | null;   // test-only override; when set, no network JWKS fetch
    clientId: string;          // 'sulo-spa' — served to the SPA by Task 3's auth-config route
    userCacheTtlMs: number;    // 60_000
  }
  ```
  reachable as `config.auth` from `api/src/config/index.ts`.

- [ ] **Step 1: Write the failing config test**

Create `api/src/config/auth.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w sulo-schema-builder-api -- src/config/auth.test.ts`
Expected: FAIL — `Cannot find module './auth.js'`.

- [ ] **Step 3: Write `config/auth.ts`**

```ts
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
```

Wire it into `api/src/config/index.ts` as `auth: resolveAuthConfig(process.env, storage)`, importing `storage` the same way the existing modules do. Follow whatever composition shape `index.ts` already uses — read it first.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w sulo-schema-builder-api -- src/config/auth.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit the realm export**

Create `docker/keycloak/realm-sulo.json`. This is the whole point of choosing Keycloak — the realm is configuration-as-code, not console clicking:

```json
{
  "realm": "sulo",
  "enabled": true,
  "displayName": "SULO Schema Builder",
  "registrationAllowed": true,
  "registrationEmailAsUsername": true,
  "verifyEmail": true,
  "resetPasswordAllowed": true,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "bruteForceProtected": true,
  "permanentLockout": false,
  "failureFactor": 10,
  "waitIncrementSeconds": 60,
  "accessTokenLifespan": 300,
  "ssoSessionIdleTimeout": 1800,
  "clients": [
    {
      "clientId": "sulo-spa",
      "name": "SULO Schema Builder SPA",
      "enabled": true,
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "implicitFlowEnabled": false,
      "serviceAccountsEnabled": false,
      "attributes": {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "http://localhost:8080/*##http://localhost:5173/*"
      },
      "redirectUris": ["http://localhost:8080/*", "http://localhost:5173/*"],
      "webOrigins": ["http://localhost:8080", "http://localhost:5173"],
      "protocolMappers": [
        {
          "name": "sulo-api-audience",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "consentRequired": false,
          "config": {
            "included.client.audience": "sulo-api",
            "access.token.claim": "true",
            "id.token.claim": "false"
          }
        }
      ]
    },
    {
      "clientId": "sulo-api",
      "name": "SULO Schema Builder API",
      "enabled": true,
      "publicClient": false,
      "bearerOnly": true,
      "standardFlowEnabled": false,
      "serviceAccountsEnabled": false
    }
  ],
  "identityProviders": [
    {
      "alias": "github",
      "providerId": "github",
      "enabled": false,
      "trustEmail": true,
      "storeToken": false,
      "config": { "clientId": "", "clientSecret": "", "defaultScope": "user:email" }
    },
    {
      "alias": "orcid",
      "providerId": "oidc",
      "enabled": false,
      "trustEmail": true,
      "storeToken": false,
      "config": {
        "clientId": "",
        "clientSecret": "",
        "issuer": "https://orcid.org",
        "authorizationUrl": "https://orcid.org/oauth/authorize",
        "tokenUrl": "https://orcid.org/oauth/token",
        "userInfoUrl": "https://orcid.org/oauth/userinfo",
        "jwksUrl": "https://orcid.org/oauth/jwks",
        "validateSignature": "true",
        "useJwksUrl": "true",
        "defaultScope": "openid"
      }
    }
  ]
}
```

**The `sulo-api-audience` mapper is load-bearing.** Keycloak access tokens carry `aud: ["account"]` by default; without that mapper the API's audience check rejects every real token while the `jose`-signed test tokens sail through — a failure that only appears against a live Keycloak. Note it in the file as a comment-bearing sibling (JSON has no comments; put the explanation in the README section you write in Step 7).

Both identity providers ship `enabled: false` with empty secrets, because OAuth client secrets do not belong in git.

- [ ] **Step 6: Add the IdP configuration helper**

Create `docker/keycloak/configure-idps.sh` — enables and fills in the brokered providers from the environment, so no one has to click through the admin console:

```bash
#!/bin/sh
# Enables the GitHub and ORCID identity providers in the `sulo` realm, using
# credentials from the environment. Safe to re-run; skips a provider whose
# variables are unset. Run against a Keycloak that already imported
# realm-sulo.json:
#
#   docker compose exec keycloak sh /opt/keycloak/bin/configure-idps.sh
#
set -eu

KC=/opt/keycloak/bin/kcadm.sh
KC_URL="${KC_URL:-http://localhost:8080}"
KC_ADMIN="${KEYCLOAK_ADMIN:-admin}"
KC_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD must be set}"

"$KC" config credentials --server "$KC_URL" --realm master --user "$KC_ADMIN" --password "$KC_ADMIN_PASSWORD"

enable_idp() {
  alias=$1; client_id=$2; client_secret=$3
  if [ -z "$client_id" ] || [ -z "$client_secret" ]; then
    echo "skipping $alias (client id/secret not set)"
    return 0
  fi
  "$KC" update "identity-provider/instances/$alias" -r sulo \
    -s enabled=true \
    -s "config.clientId=$client_id" \
    -s "config.clientSecret=$client_secret"
  echo "enabled $alias"
}

enable_idp github "${GITHUB_CLIENT_ID:-}" "${GITHUB_CLIENT_SECRET:-}"
enable_idp orcid  "${ORCID_CLIENT_ID:-}"  "${ORCID_CLIENT_SECRET:-}"
```

- [ ] **Step 7: Add the Keycloak service to compose and document it**

In `docker-compose.yml` add a `keycloak` service. It needs its own database schema — give it a separate Postgres database rather than sharing the app's tables:

```yaml
  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    command: ["start-dev", "--import-realm"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: ${KEYCLOAK_ADMIN:-admin}
      KC_BOOTSTRAP_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD:-admin}
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://db:5432/keycloak
      KC_DB_USERNAME: sulo
      KC_DB_PASSWORD: ${POSTGRES_PASSWORD:-sulo}
      KC_HTTP_PORT: 8080
      KC_HEALTH_ENABLED: "true"
    volumes:
      - ./docker/keycloak/realm-sulo.json:/opt/keycloak/data/import/realm-sulo.json:ro
      - ./docker/keycloak/configure-idps.sh:/opt/keycloak/bin/configure-idps.sh:ro
    ports:
      - "8088:8080"
    depends_on:
      db:
        condition: service_healthy
    networks:
      - sulo-net
    restart: unless-stopped
```

`start-dev` is correct for this plan (HTTP, no hostname strictness) and must be replaced before any real deployment — say so in the README. The `keycloak` database has to exist: add it to the `db` service by mounting an init script (`docker/postgres/init-keycloak.sql` containing `CREATE DATABASE keycloak OWNER sulo;`) at `/docker-entrypoint-initdb.d/`, and note in the README that this only runs on a fresh volume.

Add to the `api` service's environment: `AUTH_ISSUER: http://keycloak:8080/realms/sulo` and `AUTH_AUDIENCE: sulo-api`. Note the in-container issuer differs from the browser-facing `http://localhost:8088/realms/sulo`: **Keycloak signs tokens with the issuer the browser used**, so the API's `AUTH_ISSUER` must match what the SPA talked to, not the internal hostname. Set `KC_HOSTNAME: http://localhost:8088` on the keycloak service and use `http://localhost:8088/realms/sulo` for `AUTH_ISSUER`, then verify by decoding a real token in Task 5. Getting this wrong produces "unexpected iss" on every request, so leave a comment in compose recording why the value is the external URL.

README: a new "Authentication" section covering the realm import, the audience mapper's purpose, `configure-idps.sh` with the four env vars, the `start-dev`-is-not-production warning, and every new variable (`AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_CLIENT_ID`, `AUTH_USER_CACHE_TTL_MS`, `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`). Add the same to `.env.example`.

- [ ] **Step 8: Verify the realm actually imports**

```bash
docker compose -f docker-compose.yml up -d db keycloak
# wait for readiness, then confirm the realm and its clients exist
curl -sf http://localhost:8088/realms/sulo/.well-known/openid-configuration | head -c 300
docker compose -f docker-compose.yml logs keycloak | grep -i "import"
docker compose -f docker-compose.yml down
```

Expected: the discovery document returns, naming `issuer` and `jwks_uri`. If the import fails, fix the realm JSON now — every later task depends on it. Record the exact `issuer` string the discovery document reports; Task 3 and Task 5 both need it to match `AUTH_ISSUER`.

- [ ] **Step 9: Run the suites and commit**

```bash
npm run typecheck
npm test
git add -A
git commit -m "feat(auth): Keycloak realm as code, and fail-fast auth config

Adds an importable sulo realm (SPA public client with PKCE, bearer-only API
client, an audience mapper so access tokens are valid for it, GitHub and ORCID
brokering disabled pending secrets), a kcadm helper to enable the providers
from the environment, and config.auth, which refuses to start a postgres
deployment that cannot verify a token."
```

---

### Task 2: `users` module and the auth plugin

**Files:**
- Create: `api/src/modules/users/repo.ts`, `api/src/modules/users/service.ts`, `api/src/modules/users/service.test.ts`, `api/src/plugins/auth.ts`, `api/src/plugins/auth.test.ts`, `api/src/test/tokens.ts`
- Modify: `api/package.json` (add `jose`)
- Test: `api/src/modules/users/service.test.ts`, `api/src/plugins/auth.test.ts`

**Interfaces:**
- Consumes: `config.auth` (Task 1); `Kysely<DB>` and the `users` table types from `api/src/db/types.ts`; `startTestDb`/`truncateAll` from `api/src/test/pg.ts`.
- Produces:
  - `api/src/test/tokens.ts`: `createTestIssuer()` → `{ jwks: string, sign(claims?: Partial<TokenClaims>): Promise<string>, issuer: string, audience: string }`, so every later task can mint a valid token without Keycloak.
  - `modules/users/repo.ts`: `upsertBySubject(db, { subject, email, displayName, orcid })` → `Selectable<UsersTable>`; `findBySubject(db, subject)`.
  - `modules/users/service.ts`: `resolveUser(db, claims: TokenClaims)` → `RequestUser`, and `LOCAL_SUBJECT = 'local'`.
  - `plugins/auth.ts`: decorates `request.user: RequestUser | null`, and `fastify.authRequired` / `fastify.requireRole(...roles)` as preHandlers.
  - Shared types (declare in `modules/users/service.ts`, re-exported where convenient):
    ```ts
    export interface TokenClaims { sub: string; email?: string; name?: string; preferred_username?: string; orcid?: string }
    export interface RequestUser { id: string; subject: string; role: 'user' | 'moderator' | 'admin'; tier: 'free' | 'verified' | 'staff' }
    ```

- [ ] **Step 1: Add `jose`**

```bash
npm install -w sulo-schema-builder-api jose
```

- [ ] **Step 2: Write the test issuer helper**

Create `api/src/test/tokens.ts`. Every auth test in this plan and the next depends on it, so it is written first even though it is not itself the unit under test:

```ts
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
```

- [ ] **Step 3: Write the failing users-service test**

Create `api/src/modules/users/service.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import * as service from './service.js';

let t: TestDb;

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => { await truncateAll(t.db); });

describe('users service', () => {
  it('provisions a user on first sight and returns defaults', async () => {
    const user = await service.resolveUser(t.db, { sub: 'kc-1', email: 'a@example.org', name: 'Ada' });

    expect(user.id).toBeTruthy();
    expect(user.subject).toBe('kc-1');
    expect(user.role).toBe('user');
    expect(user.tier).toBe('free');
  });

  it('is idempotent: the same subject keeps the same id', async () => {
    const first = await service.resolveUser(t.db, { sub: 'kc-1', email: 'a@example.org' });
    const second = await service.resolveUser(t.db, { sub: 'kc-1', email: 'a@example.org' });

    expect(second.id).toBe(first.id);
    const { rows } = await t.pool.query('select count(*)::int as n from users where subject = $1', ['kc-1']);
    expect(rows[0].n).toBe(1);
  });

  it('refreshes mirrored claims and last_seen_at on a later sighting', async () => {
    await service.resolveUser(t.db, { sub: 'kc-1', email: 'old@example.org', name: 'Old' });
    await service.resolveUser(t.db, { sub: 'kc-1', email: 'new@example.org', name: 'New', orcid: '0000-0002-1825-0097' });

    const { rows } = await t.pool.query(
      'select email, display_name, orcid, last_seen_at from users where subject = $1', ['kc-1'],
    );
    expect(rows[0].email).toBe('new@example.org');
    expect(rows[0].display_name).toBe('New');
    expect(rows[0].orcid).toBe('0000-0002-1825-0097');
    expect(rows[0].last_seen_at).not.toBeNull();
  });

  it('never overwrites a role or tier an administrator set', async () => {
    const user = await service.resolveUser(t.db, { sub: 'kc-1' });
    await t.pool.query('update users set global_role = $1, quota_tier = $2 where id = $3', ['admin', 'staff', user.id]);

    const again = await service.resolveUser(t.db, { sub: 'kc-1' });
    expect(again.role).toBe('admin');
    expect(again.tier).toBe('staff');
  });

  it('falls back to preferred_username when no name claim is present', async () => {
    await service.resolveUser(t.db, { sub: 'kc-2', preferred_username: 'ada' });
    const { rows } = await t.pool.query('select display_name from users where subject = $1', ['kc-2']);
    expect(rows[0].display_name).toBe('ada');
  });

  it('refuses the reserved local subject', async () => {
    await expect(service.resolveUser(t.db, { sub: 'local' })).rejects.toThrow(/reserved/i);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -w sulo-schema-builder-api -- src/modules/users/service.test.ts`
Expected: FAIL — `Cannot find module './service.js'`.

- [ ] **Step 5: Write the users repository and service**

`api/src/modules/users/repo.ts`:

```ts
import type { Kysely, Selectable } from 'kysely';
import type { DB, UsersTable } from '../../db/types.js';

export type UserRow = Selectable<UsersTable>;

export interface UpsertUser {
  subject: string;
  email: string | null;
  displayName: string | null;
  orcid: string | null;
}

/**
 * Creates the mirror row on first sight, refreshes the mirrored claims after.
 * global_role and quota_tier are deliberately absent from the update: they are
 * administrative state, not token state, so a later sign-in must not reset a
 * promotion.
 */
export async function upsertBySubject(db: Kysely<DB>, values: UpsertUser): Promise<UserRow> {
  return db
    .insertInto('users')
    .values({
      subject: values.subject,
      email: values.email,
      display_name: values.displayName,
      orcid: values.orcid,
      last_seen_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column('subject').doUpdateSet({
        email: values.email,
        display_name: values.displayName,
        orcid: values.orcid,
        last_seen_at: new Date(),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findBySubject(db: Kysely<DB>, subject: string): Promise<UserRow | undefined> {
  return db.selectFrom('users').selectAll().where('subject', '=', subject).executeTakeFirst();
}
```

`api/src/modules/users/service.ts`:

```ts
// Maps verified token claims onto the local users row. Keycloak owns
// credentials; this is the mirror the rest of the API joins against.

import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import * as repo from './repo.js';

/**
 * Subject of the pre-auth seed row (migration 002). It owns every schema
 * created before authentication existed. Keycloak must never be able to issue
 * it as a `sub`, or a signed-in user would inherit those schemas — hence the
 * explicit rejection in resolveUser rather than a comment asking nicely.
 */
export const LOCAL_SUBJECT = 'local';

export interface TokenClaims {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  orcid?: string;
}

export interface RequestUser {
  id: string;
  subject: string;
  role: 'user' | 'moderator' | 'admin';
  tier: 'free' | 'verified' | 'staff';
}

export async function resolveUser(db: Kysely<DB>, claims: TokenClaims): Promise<RequestUser> {
  const subject = claims.sub?.trim();
  if (!subject) throw new Error('token has no subject');
  if (subject === LOCAL_SUBJECT) {
    throw new Error(`subject "${LOCAL_SUBJECT}" is reserved for the pre-auth seed row and cannot be authenticated`);
  }

  const row = await repo.upsertBySubject(db, {
    subject,
    email: claims.email?.trim() || null,
    displayName: claims.name?.trim() || claims.preferred_username?.trim() || null,
    orcid: claims.orcid?.trim() || null,
  });

  return { id: row.id, subject: row.subject, role: row.global_role, tier: row.quota_tier };
}
```

- [ ] **Step 6: Run the users test to verify it passes**

Run: `npm test -w sulo-schema-builder-api -- src/modules/users/service.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Write the failing auth-plugin test**

Create `api/src/plugins/auth.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { startTestDb, truncateAll, type TestDb } from '../test/pg.js';
import { createTestIssuer, type TestIssuer } from '../test/tokens.js';

let t: TestDb;
let issuer: TestIssuer;

beforeAll(async () => {
  t = await startTestDb();
  issuer = await createTestIssuer();
});
afterAll(async () => { await t.stop(); });
beforeEach(async () => { await truncateAll(t.db); });

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(sensible);
  app.decorate('pg', t.db);

  const { default: authPlugin } = await import('./auth.js');
  await app.register(authPlugin, {
    auth: {
      enabled: true,
      issuer: issuer.issuer,
      audience: issuer.audience,
      jwksUri: `${issuer.issuer}/protocol/openid-connect/certs`,
      jwksJson: issuer.jwks,
      clientId: 'sulo-spa',
      userCacheTtlMs: 60_000,
    },
  });

  app.get('/open', async (request) => ({ user: request.user?.subject ?? null }));
  app.get('/closed', { preHandler: app.authRequired }, async (request) => ({ id: request.user!.id }));
  app.get('/admin-only', { preHandler: [app.authRequired, app.requireRole('admin')] }, async () => ({ ok: true }));

  await app.ready();
  return app;
}

describe('auth plugin', () => {
  it('leaves request.user null on an unauthenticated open route', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/open' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null });
    await app.close();
  });

  it('401s a guarded route with no token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/closed' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts a valid token and provisions the user', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'kc-42', email: 'a@example.org' });

    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBeTruthy();

    const { rows } = await t.pool.query('select subject from users where subject = $1', ['kc-42']);
    expect(rows).toHaveLength(1);
    await app.close();
  });

  it('rejects a token from the wrong issuer', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'kc-42' }, { issuer: 'https://evil.example/realms/sulo' });
    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a token minted for another audience', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'kc-42' }, { audience: 'account' });
    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an expired token', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'kc-42' }, { expiresIn: '-1m' });
    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a malformed authorization header', async () => {
    const app = await buildApp();
    for (const authorization of ['', 'Bearer', 'Basic abc', 'Bearer not.a.jwt']) {
      const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization } });
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });

  it('403s a role-guarded route for an ordinary user, and allows an admin', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'kc-42' });

    const denied = await app.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(denied.statusCode).toBe(403);

    await t.pool.query('update users set global_role = $1 where subject = $2', ['admin', 'kc-42']);
    // The role cache is keyed by subject with a TTL, so a fresh app instance
    // proves the guard reads the database rather than the token.
    const app2 = await buildApp();
    const allowed = await app2.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(allowed.statusCode).toBe(200);

    await app.close();
    await app2.close();
  });

  it('refuses a token whose subject is the reserved local seed', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'local' });
    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npm test -w sulo-schema-builder-api -- src/plugins/auth.test.ts`
Expected: FAIL — `Cannot find module './auth.js'`.

- [ ] **Step 9: Write the auth plugin**

```ts
// Verifies Keycloak-issued bearer tokens and attaches the local user row.
//
// Registered only in postgres mode (see server.ts): the packaged desktop build
// is single-user and loopback-bound, and pulling `jose` into that snapshot
// would buy nothing.

import fp from 'fastify-plugin';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { resolveUser, type RequestUser, type TokenClaims } from '../modules/users/service.js';
import type { AuthConfig } from '../config/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    authRequired: preHandlerHookHandler;
    requireRole: (...roles: RequestUser['role'][]) => preHandlerHookHandler;
  }
  interface FastifyRequest {
    user: RequestUser | null;
  }
}

export interface AuthPluginOptions {
  auth: AuthConfig;
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!/^bearer$/i.test(scheme) || rest.length !== 1) return null;
  return rest[0].trim() || null;
}

export default fp<AuthPluginOptions>(async (fastify, opts) => {
  const auth = opts.auth;

  // A literal JWKS (tests) verifies offline; a deployment fetches and caches
  // Keycloak's, re-fetching on an unknown `kid` so a key rotation heals itself.
  const getKey: JWTVerifyGetKey = auth.jwksJson
    ? createLocalJWKSet(JSON.parse(auth.jwksJson))
    : createRemoteJWKSet(new URL(auth.jwksUri));

  // Subject → user, so a burst of requests from one client is one database
  // round-trip. Short TTL: an administrator's role change must take effect
  // without a restart.
  const cache = new Map<string, { at: number; user: RequestUser }>();

  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request) => {
    const token = bearer(request);
    if (!token) return;

    let claims: TokenClaims;
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: auth.issuer,
        audience: auth.audience,
        clockTolerance: 5,
      });
      claims = payload as unknown as TokenClaims;
    } catch (err) {
      // An unverifiable token is anonymity, not an error: the guards below
      // decide whether that is fatal for this route. Logged at debug because a
      // public deployment sees expired tokens constantly.
      request.log.debug({ err }, 'bearer token rejected');
      return;
    }

    const cached = cache.get(claims.sub);
    if (cached && Date.now() - cached.at < auth.userCacheTtlMs) {
      request.user = cached.user;
      return;
    }

    try {
      const user = await resolveUser(fastify.pg, claims);
      cache.set(claims.sub, { at: Date.now(), user });
      request.user = user;
    } catch (err) {
      request.log.warn({ err, sub: claims.sub }, 'could not resolve a verified token to a user');
    }
  });

  fastify.decorate('authRequired', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) return reply.unauthorized('Sign in to continue.');
  });

  fastify.decorate('requireRole', (...roles: RequestUser['role'][]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.unauthorized('Sign in to continue.');
      if (!roles.includes(request.user.role)) return reply.forbidden('Your account cannot perform this action.');
    });
});
```

- [ ] **Step 10: Run the plugin test to verify it passes**

Run: `npm test -w sulo-schema-builder-api -- src/plugins/auth.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 11: Full suites, typecheck, and commit**

```bash
npm run typecheck
npm test
git add -A
git commit -m "feat(auth): verify Keycloak tokens and mirror users locally

The plugin verifies issuer, audience, expiry and signature against Keycloak's
JWKS, JIT-provisions a users row keyed on the token subject, and exposes
authRequired/requireRole. Administrative role and tier survive re-authentication;
the reserved 'local' seed subject is rejected outright. Tests sign their own
tokens, so no Keycloak is needed to run them."
```

---

### Task 3: Wire identity into the API

**Files:**
- Modify: `api/src/server.ts`, `api/src/modules/schemas/routes.ts`, `api/src/routes/v1/index.ts`, `api/src/routes/v1/upperConcepts.ts`, `api/src/routes/v1/reason.ts`
- Create: `api/src/routes/v1/authConfig.ts`, `api/src/modules/schemas/routes.auth.test.ts`
- Test: `api/src/modules/schemas/routes.auth.test.ts`, plus the existing `routes.test.ts` updated for the new requirement

**Interfaces:**
- Consumes: `authRequired`/`requireRole`/`request.user` (Task 2); `config.auth` (Task 1).
- Produces: `GET /api/v1/auth-config` → `{ enabled: boolean, issuer: string, clientId: string }` (no secrets — this is public by design, the SPA needs it before it can authenticate). Every `/ontology-schemas*` route, both upper-concept routes and every `/reason*` route requires a session in postgres mode. `service.listSchemas`/`createSchema` are called with `request.user.id` instead of `LOCAL_OWNER_ID`.

- [ ] **Step 1: Write the failing ownership/authentication test**

Create `api/src/modules/schemas/routes.auth.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { createTestIssuer, type TestIssuer } from '../../test/tokens.js';
import schemasRoutes from './routes.js';

let t: TestDb;
let issuer: TestIssuer;
let app: FastifyInstance;

beforeAll(async () => {
  t = await startTestDb();
  issuer = await createTestIssuer();

  app = Fastify();
  await app.register(sensible);
  app.decorate('pg', t.db);
  const { default: authPlugin } = await import('../../plugins/auth.js');
  await app.register(authPlugin, {
    auth: {
      enabled: true, issuer: issuer.issuer, audience: issuer.audience,
      jwksUri: `${issuer.issuer}/protocol/openid-connect/certs`,
      jwksJson: issuer.jwks, clientId: 'sulo-spa', userCacheTtlMs: 60_000,
    },
  });
  await app.register(schemasRoutes, { prefix: '/ontology-schemas' });
  await app.ready();
});

afterAll(async () => { await app.close(); await t.stop(); });
beforeEach(async () => { await truncateAll(t.db); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('schema routes under authentication', () => {
  it('401s every route without a token', async () => {
    for (const [method, url] of [
      ['GET', '/ontology-schemas'],
      ['POST', '/ontology-schemas'],
      ['GET', '/ontology-schemas/11111111-1111-1111-1111-111111111111'],
      ['PATCH', '/ontology-schemas/11111111-1111-1111-1111-111111111111'],
      ['DELETE', '/ontology-schemas/11111111-1111-1111-1111-111111111111'],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'GET' || method === 'DELETE' ? undefined : { title: 'x' } });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('attributes a created schema to the caller', async () => {
    const token = await issuer.sign({ sub: 'kc-owner' });
    const created = (await app.inject({
      method: 'POST', url: '/ontology-schemas', headers: auth(token), payload: { title: 'Mine' },
    })).json();

    const { rows } = await t.pool.query(
      'select u.subject from schemas s join users u on u.id = s.owner_id where s.id = $1', [created.id],
    );
    expect(rows[0].subject).toBe('kc-owner');
  });

  it('lists only the caller own schemas', async () => {
    const alice = await issuer.sign({ sub: 'kc-alice' });
    const bob = await issuer.sign({ sub: 'kc-bob' });

    await app.inject({ method: 'POST', url: '/ontology-schemas', headers: auth(alice), payload: { title: 'Alice A' } });
    await app.inject({ method: 'POST', url: '/ontology-schemas', headers: auth(bob), payload: { title: 'Bob B' } });

    const mine = (await app.inject({ method: 'GET', url: '/ontology-schemas', headers: auth(alice) })).json();
    expect(mine.map((s: { title: string }) => s.title)).toEqual(['Alice A']);
  });

  it('two sign-ins by the same subject share one owner row', async () => {
    const token = await issuer.sign({ sub: 'kc-alice' });
    await app.inject({ method: 'POST', url: '/ontology-schemas', headers: auth(token), payload: { title: 'One' } });
    await app.inject({ method: 'POST', url: '/ontology-schemas', headers: auth(token), payload: { title: 'Two' } });

    const mine = (await app.inject({ method: 'GET', url: '/ontology-schemas', headers: auth(token) })).json();
    expect(mine).toHaveLength(2);
    const { rows } = await t.pool.query('select count(*)::int as n from users where subject = $1', ['kc-alice']);
    expect(rows[0].n).toBe(1);
  });
});
```

Note what this test does NOT assert: that Bob is refused a direct `GET` of Alice's schema by id. Cross-user read protection is the ACL's job (plan 3) — resist adding it here, and leave a comment in the test file saying so, otherwise the next reader will think it was forgotten.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w sulo-schema-builder-api -- src/modules/schemas/routes.auth.test.ts`
Expected: FAIL — the 401 assertions fail (routes are currently open) and the ownership assertion fails (`LOCAL_OWNER_ID` owns everything).

- [ ] **Step 3: Require a session on the schema routes and key them on the caller**

In `api/src/modules/schemas/routes.ts`:
- Delete the `LOCAL_OWNER_ID` import and both uses.
- Add `{ preHandler: fastify.authRequired }` to every route in the plugin (all twelve).
- `GET /` becomes `service.listSchemas(fastify.pg, request.user!.id)`; `POST /` becomes `service.createSchema(fastify.pg, request.user!.id, data)`.
- Replace the file's header note about `LOCAL_OWNER_ID` with one describing the current state: every route needs a session, ownership comes from the token, and per-schema authorization (visibility, grants, cross-user reads) arrives in plan 3.

`request.user!` is safe after `authRequired`, but prefer a tiny local helper over scattering non-null assertions:

```ts
function requireUser(request: FastifyRequest): RequestUser {
  if (!request.user) throw new Error('route is missing the authRequired preHandler');
  return request.user;
}
```

That converts a wiring mistake into a loud 500 during development instead of a confusing crash in production.

- [ ] **Step 4: Run the auth test to verify it passes**

Run: `npm test -w sulo-schema-builder-api -- src/modules/schemas/routes.auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Fix the pre-existing route suite**

`api/src/modules/schemas/routes.test.ts` and `repo.test.ts` were written against open routes. Update `routes.test.ts` so its app registers the auth plugin (the same block the new test uses — extract it into a shared helper in `api/src/test/` rather than copying it a third time) and every request carries a token for a single fixed subject. Keep every existing assertion: the 400/404/422 behaviours, the mapping-pattern round trip, the `''`-clears cases and the cross-schema child-write rejections are all still required. `repo.test.ts` talks to the service layer directly and needs no token, but its `LOCAL_OWNER_ID` fixture must keep working — that row still exists, and nothing in this task removes it.

- [ ] **Step 6: Add the auth-config route**

Create `api/src/routes/v1/authConfig.ts`:

```ts
// GET /auth-config — what the SPA needs before it can authenticate.
//
// One SPA build serves every deployment, so it cannot know at compile time
// whether it is talking to the multi-user web API or the single-user desktop
// sidecar. `enabled: false` means "no login UI, no bearer tokens" — the
// packaged desktop path.
//
// Public by design: an issuer URL and a public client id are not secrets, and
// the browser is about to send them to Keycloak anyway.

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
```

Register it in `api/src/routes/v1/index.ts` before the guarded routes, and leave it unguarded — a client that cannot reach it cannot log in.

- [ ] **Step 7: Close the remaining anonymous surface**

Per design §5, an anonymous visitor must not be able to make the server dereference a remote IRI or spend reasoner time:
- `api/src/routes/v1/upperConcepts.ts`: add `fastify.authRequired` to the standalone proxy. Keep the existing per-route rate limit and the guarded fetch untouched.
- `api/src/modules/schemas/routes.ts`: the schema-scoped upper-concepts route is already covered by Step 3.
- `api/src/routes/v1/reason.ts`: add `authRequired` to `POST /` (the reasoning run) and to `POST /sulo/check`. Leave `GET /status` open — the SPA renders its setup state before login — and leave `/java-path` and `/robot/download` exactly as they are, since they already 403 unless `isPackaged`.

**These guards must be conditional on auth being enabled**, because `authRequired` does not exist as a decorator in sqlite mode where the plugin is never registered. Register the guard as a no-op decorator in that mode rather than sprinkling `config.auth.enabled` checks through the route files — decide where that belongs (a tiny `plugins/authDisabled.ts` registered in the else-branch of `server.ts` is the obvious spot) and document the choice.

- [ ] **Step 8: Register the plugin in the server**

In `api/src/server.ts`, register the auth plugin inside the existing `config.storage === 'postgres'` branch, immediately after the pg plugin (it needs `fastify.pg`), passing `{ auth: config.auth }`. Load it with `await import()` exactly as `plugins/pg.js` is loaded, and add a sentence to that branch's existing comment explaining that `jose` is kept out of the packaged snapshot for the same reason `kysely` is. In the `else` branch, register the no-op guard plugin from Step 7.

- [ ] **Step 9: Verify both modes and commit**

```bash
npm run typecheck
npm test
npm run build -w sulo-schema-builder-api
# sqlite mode must still boot and serve without any token
node api/dist/index.js &
sleep 2 && curl -sf localhost:3000/api/v1/health && curl -sf localhost:3000/api/v1/auth-config && curl -sf localhost:3000/api/v1/ontology-schemas
kill %1
# the packaged binary is the gate that has caught two regressions in this project
node api/scripts/package-desktop.mjs && api/pkg-dist/sulo-schema-builder-api & sleep 3
curl -sf localhost:3000/api/v1/health; kill %1
```

Expected: in sqlite mode `auth-config` reports `enabled: false`, the schema list returns without a token, and the packaged binary boots. Then commit:

```bash
git add -A
git commit -m "feat(auth): require a session on the web API, own schemas by caller

Schema, upper-concept and reasoning routes now require a verified token in
postgres mode, and a schema belongs to the user who created it instead of the
pre-auth seed row. Adds GET /auth-config so one SPA build can discover whether
it must authenticate. The frozen SQLite desktop path registers no auth plugin
and behaves exactly as before."
```

---

### Task 4: Frontend login

**Files:**
- Create: `frontend/src/auth/keycloak.ts`, `frontend/src/auth/AuthProvider.tsx`, `frontend/src/auth/useAuth.ts`, `frontend/src/auth/AuthProvider.test.tsx`, `frontend/src/api/authConfig.ts`, `frontend/src/api/client.test.ts`, `frontend/src/components/layout/UserMenu.tsx`
- Modify: `frontend/src/api/client.ts`, `frontend/src/main.tsx`, `frontend/src/components/layout/NavBar.tsx`, `frontend/package.json`, `frontend/vite-env.d.ts` (create if absent), `docker/api/Dockerfile` (build args, if the SPA needs any — prefer runtime discovery and add none)
- Test: `frontend/src/api/client.test.ts`, `frontend/src/auth/AuthProvider.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/auth-config` (Task 3).
- Produces: `useAuth()` → `{ status: 'loading' | 'disabled' | 'anonymous' | 'authenticated', user: { name?: string; email?: string } | null, login(): void, logout(): void }`; an axios request interceptor attaching `Authorization: Bearer …` when a token exists, and a response interceptor that refreshes once on 401 and retries.

- [ ] **Step 1: Add `keycloak-js`**

```bash
npm install -w sulo-schema-builder-frontend keycloak-js
```

- [ ] **Step 2: Write the failing interceptor test**

Create `frontend/src/api/client.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiClient, setTokenProvider } from './client.js';

describe('apiClient auth interceptor', () => {
  beforeEach(() => { setTokenProvider(null); });

  it('sends no Authorization header when no provider is set', async () => {
    const config = await apiClient.interceptors.request.handlers[0].fulfilled({ headers: {} });
    expect(config.headers.Authorization).toBeUndefined();
  });

  it('attaches the bearer token from the provider', async () => {
    setTokenProvider({ getToken: async () => 'tok-123', refresh: async () => true });
    const config = await apiClient.interceptors.request.handlers[0].fulfilled({ headers: {} });
    expect(config.headers.Authorization).toBe('Bearer tok-123');
  });

  it('omits the header when the provider returns no token', async () => {
    setTokenProvider({ getToken: async () => null, refresh: async () => true });
    const config = await apiClient.interceptors.request.handlers[0].fulfilled({ headers: {} });
    expect(config.headers.Authorization).toBeUndefined();
  });

  it('refreshes once and retries on a 401', async () => {
    const refresh = vi.fn(async () => true);
    setTokenProvider({ getToken: async () => 'tok-123', refresh });

    const retry = vi.fn(async () => ({ data: 'ok' }));
    const rejected = apiClient.interceptors.response.handlers[0].rejected;
    const result = await rejected({
      response: { status: 401 },
      config: { headers: {}, __retried: undefined, adapter: retry },
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: 'ok' });
  });

  it('does not loop: a second 401 on the retried request rejects', async () => {
    const refresh = vi.fn(async () => true);
    setTokenProvider({ getToken: async () => 'tok-123', refresh });

    const rejected = apiClient.interceptors.response.handlers[0].rejected;
    await expect(rejected({ response: { status: 401 }, config: { headers: {}, __retried: true } })).rejects.toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});
```

Reaching into `interceptors.handlers` is deliberate: it tests the interceptors as units without a network or a mock server. If the implementer prefers `axios-mock-adapter`, that is acceptable — but the five behaviours above must all be covered.

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w sulo-schema-builder-frontend -- src/api/client.test.ts`
Expected: FAIL — `setTokenProvider` is not exported by `./client.js`.

- [ ] **Step 4: Add the interceptors**

Rewrite `frontend/src/api/client.ts`:

```ts
import axios from 'axios';

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
});

/**
 * How the client obtains a token. Set by AuthProvider once Keycloak is ready;
 * left null on the desktop build, where the API needs no token. Keeping this
 * an injected seam (rather than importing Keycloak here) is what lets the
 * interceptors be unit-tested and keeps the API layer free of auth machinery.
 */
export interface TokenProvider {
  getToken: () => Promise<string | null>;
  refresh: () => Promise<boolean>;
}

let tokenProvider: TokenProvider | null = null;

export function setTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
}

apiClient.interceptors.request.use(async (config) => {
  const token = await tokenProvider?.getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error?.config;
    // One refresh-and-retry per request: an access token that expired mid-flight
    // is routine, but a 401 on the retried request means the session is gone and
    // looping would hammer both Keycloak and the API.
    if (error?.response?.status === 401 && tokenProvider && config && !config.__retried) {
      config.__retried = true;
      const refreshed = await tokenProvider.refresh();
      if (refreshed) return apiClient.request(config);
    }
    throw error;
  },
);
```

- [ ] **Step 5: Run the interceptor test to verify it passes**

Run: `npm test -w sulo-schema-builder-frontend -- src/api/client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing AuthProvider test**

Create `frontend/src/auth/AuthProvider.test.tsx`. Mock `keycloak-js` with a fake whose `init` resolves to a configurable authentication state, and assert:
1. While `/auth-config` is in flight, `status` is `'loading'`.
2. When the endpoint reports `enabled: false`, `status` becomes `'disabled'`, Keycloak is never constructed, and `setTokenProvider` is not called.
3. When `enabled: true` and `init` reports not-authenticated, `status` is `'anonymous'` and `login()` calls Keycloak's `login`.
4. When `init` reports authenticated, `status` is `'authenticated'`, `user` carries the token's name/email, and a token provider was installed.
5. When `/auth-config` rejects, the app degrades to `'disabled'` rather than rendering nothing — a builder that works without login beats a white screen.

Write the assertions concretely, using `@testing-library/react`'s `renderHook` (already a devDependency) with a small probe component. Mock the axios client module, not the network.

- [ ] **Step 7: Run it to verify it fails, then implement**

Run: `npm test -w sulo-schema-builder-frontend -- src/auth/AuthProvider.test.tsx`
Expected: FAIL — the module does not exist.

Then write:
- `frontend/src/api/authConfig.ts` — fetches `GET /auth-config` once and memoises the promise (the pattern the deleted `appConfig.ts` used; it is a good pattern, reuse its shape), returning `{ enabled, issuer, clientId }` and degrading to `{ enabled: false }` on error.
- `frontend/src/auth/keycloak.ts` — constructs the `Keycloak` instance from that config (`url` is the issuer with `/realms/<realm>` stripped, `realm` is its last path segment, `clientId` as given). Parse the issuer rather than adding new env vars: the server already knows the truth, and a second source would drift.
- `frontend/src/auth/AuthProvider.tsx` — runs `init({ onLoad: 'check-sso', pkceMethod: 'S256', silentCheckSsoRedirectUri: … })`, installs the `TokenProvider` (`getToken` returns the current token, `refresh` calls `updateToken(30)`), exposes context, and renders children in every state.
- `frontend/src/auth/useAuth.ts` — the context hook.

Use `check-sso` rather than `login-required`: the builder must stay usable for an anonymous visitor in the desktop build and must not bounce a first-time web visitor straight to a login page before they have seen the app.

- [ ] **Step 8: Add the user menu**

Create `frontend/src/components/layout/UserMenu.tsx` — renders nothing when `status === 'disabled'`, a "Sign in" button when `'anonymous'`, and the display name plus a "Sign out" action when `'authenticated'`. Match the existing NavBar styling (dark slate bar, `text-sm font-medium`, violet accent). Mount it in `NavBar.tsx` at the right-hand end of the existing flex row; wrap `<App />` in `<AuthProvider>` in `main.tsx`.

- [ ] **Step 9: Verify and commit**

```bash
npm run build -w @sulo/schema-core
npm run typecheck
npm test
npm run build -w sulo-schema-builder-frontend
```

Expected: all clean. Commit:

```bash
git add -A
git commit -m "feat(auth): sign in through Keycloak from the SPA

Discovers whether the deployment requires authentication from
GET /auth-config, so one build serves both the web deployment and the
desktop sidecar. Tokens live in memory, attach through an axios interceptor,
and refresh once on a 401 before the request is retried."
```

---

### Task 5: End-to-end proof against a real Keycloak

**Files:**
- Create: `frontend/e2e/auth-flow.spec.ts`, `docker/keycloak/seed-test-user.sh`
- Modify: `frontend/playwright.config.ts`, `.github/workflows/ci.yml`, `README.md`
- Test: `frontend/e2e/auth-flow.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: an end-to-end test that signs in through Keycloak's own login page and creates a schema owned by that account; a CI job that runs it against the compose stack.

Everything so far has been proved against `jose`-signed tokens. This task is where the audience mapper, the issuer mismatch trap from Task 1 Step 7, PKCE, and the redirect URIs are proved against the real thing — the class of failure that unit tests structurally cannot catch, and the reason the packaged-binary gate existed in plan 1.

- [ ] **Step 1: Add a deterministic test user**

Create `docker/keycloak/seed-test-user.sh` — a `kcadm` script creating `e2e@example.org` with a fixed password, email pre-verified, idempotent on re-run. Model it on `configure-idps.sh`. Document that it is for local and CI use only.

- [ ] **Step 2: Write the failing e2e test**

Create `frontend/e2e/auth-flow.spec.ts` asserting, against a running stack:
1. An anonymous visit to `/` shows the app with a "Sign in" affordance and no schema list.
2. Clicking "Sign in" lands on Keycloak's login page (assert the URL host and the realm path).
3. Signing in as the seeded user returns to the app, authenticated, with the display name visible.
4. Creating a schema succeeds, and reloading still shows it.
5. Signing out returns to the anonymous state and the schema is no longer listed.
6. `POST /api/v1/ontology-schemas` with no token returns 401 (a direct `request` call, proving the guard rather than the UI).

Read `frontend/e2e/schema-flow.spec.ts` first and follow its conventions.

- [ ] **Step 3: Run it against a local stack**

```bash
docker compose -f docker-compose.yml up -d --build
# seed the user once Keycloak is ready
docker compose -f docker-compose.yml exec keycloak sh /opt/keycloak/bin/seed-test-user.sh
npx playwright test -c frontend/playwright.config.ts frontend/e2e/auth-flow.spec.ts
docker compose -f docker-compose.yml down
```

Expected: all six assertions pass. **If the token is rejected with an issuer or audience error, that is the Task 1 Step 7 trap, not a test bug** — fix `AUTH_ISSUER`/`KC_HOSTNAME` or the audience mapper, and record what the real token contained in your report.

- [ ] **Step 4: Add the CI job**

Add a job to `.github/workflows/ci.yml` that boots the compose stack, seeds the user, runs this spec, and uploads the Playwright report on failure. Keep it a separate job from the fast unit-test gate so a Keycloak hiccup cannot block every PR on unrelated changes, and give it a sensible timeout. State plainly in the job's comment that it is the only automated proof that real Keycloak tokens are accepted.

- [ ] **Step 5: Document and commit**

README: how to run the e2e suite locally, the seeded credentials, and a short "what to check when login breaks" list (issuer mismatch, missing audience mapper, redirect URI, `check-sso` needing third-party cookies or a silent-check page).

```bash
npm run typecheck && npm test
git add -A
git commit -m "test(auth): prove the login flow against a real Keycloak

Signs in through Keycloak's own pages, creates a schema as that account and
checks the API refuses an anonymous write — covering the audience mapper,
issuer matching, PKCE and redirect URIs, none of which the offline
token tests can exercise."
```

---

## Self-Review

**Spec coverage (§4, plus the two §5 clauses pulled forward):**

| Spec requirement | Task |
| --- | --- |
| Keycloak realm, SPA public client with PKCE | 1 |
| GitHub + ORCID brokering | 1 (config committed, secrets via `configure-idps.sh`) |
| Registration, email verification, brute-force detection | 1 (realm JSON) |
| Realm exported to `docker/keycloak/` and imported on start | 1 |
| JWT verification with `jose` + cached JWKS, issuer/audience/exp checks | 2 |
| `request.user`, JIT `users` upsert, in-process LRU with TTL | 2 |
| `authRequired` / `requireRole` guards | 2 |
| Registered only when `SCHEMA_STORAGE=postgres` | 3 (Step 8) |
| Frontend `keycloak-js`, in-memory token, axios interceptor, retry-once on 401 | 4 |
| Hosted login/registration/reset pages (no credential UI in this repo) | 4 (by construction — `check-sso` + redirect) |
| Tests need no Keycloak; keypair + `AUTH_JWKS_JSON` override; no bypass flag | 2 (`test/tokens.ts`), global constraints |
| §5: anonymous callers cannot reach the reasoner or the upper-ontology proxy | 3 (Step 7) |
| §5: `'local'` must never be issuable as a Keycloak `sub` | 2 (`resolveUser` rejects it, with a test) |
| Playwright login e2e against a Keycloak container in CI | 5 |

Deliberately out of scope, deferred to plan 3: visibility (`private`/`unlisted`/`public`), grants and the `schema_grants` table, the access resolver, 404-not-403 for private schemas, `?scope=mine|shared|public`, anonymous reads of public schemas, ownership transfer, and moderator unpublish. The columns and tables all exist already from migration 001, so plan 3 adds no `ALTER`.

**Type consistency:** `AuthConfig` (Task 1) is the option type the plugin takes (Task 2) and the shape `config.auth` exposes (Task 3). `RequestUser` and `TokenClaims` are declared once in `modules/users/service.ts` and consumed by the plugin and the routes. `TestIssuer` from `api/src/test/tokens.ts` is used by Tasks 2, 3 and (indirectly) 5. `TokenProvider` is declared in `frontend/src/api/client.ts` and implemented by `AuthProvider` — the only two places that mention it.

**Known trap, restated because it will cost someone an afternoon:** Keycloak signs tokens with the issuer the *browser* reached it on, so the API's `AUTH_ISSUER` must be the externally visible URL (`http://localhost:8088/realms/sulo`), not the in-container hostname. And without the `sulo-api-audience` mapper, real tokens carry `aud: ["account"]` and fail the audience check while every offline test passes. Both are called out at their point of use, in Task 1 Step 7 and Task 5 Step 3.
