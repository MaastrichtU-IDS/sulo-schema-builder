# sulo-schema-builder

Helm chart for the SULO Schema Builder API — the Fastify service that also
serves the built React SPA (`docker/api/Dockerfile`, `target: production`).

## Scope — what this chart does NOT deploy

Postgres and Keycloak are treated as **pre-existing, externally managed
services**, the same split `docker-compose.yml` documents for a non-local
deployment:

- **Postgres**: point `database.url` (or `database.existingSecret`) at
  whatever instance you already run. This chart's only interaction with it
  is the `<release>-migrate` Job, which applies `api/migrations/*.sql` — it
  does not create the database or manage its lifecycle.
- **Keycloak**: point `config.authIssuer` / `config.authJwksUri` at whatever
  realm you already run. This chart does not deploy Keycloak, import a
  realm, or manage clients.

If your environment doesn't have either yet, provision them as their own
ArgoCD Applications (or via `docker/keycloak/realm-sulo.json` as a starting
realm import) alongside this chart, not inside it.

`.github/workflows/docker-publish.yml` builds `docker/api/Dockerfile`'s
`production` stage and pushes it to `ghcr.io/maastrichtu-ids/sulo-schema-
builder/api` on every `v*` tag push — `values.yaml`'s `image.repository`
already points there. A newly created GHCR package defaults to **private**;
either make it public or set `imagePullSecrets` with credentials that can
pull it before relying on this default.

## Required values

At minimum, fill in:

```yaml
image:
  tag: "0.1.1"   # a tag actually published by docker-publish.yml

config:
  authIssuer: https://auth.example.org/realms/sulo
  authJwksUri: http://keycloak.identity.svc.cluster.local/realms/sulo/protocol/openid-connect/certs

database:
  existingSecret: sulo-schema-builder-db   # a Secret you (or External Secrets
  existingSecretKey: DATABASE_URL          # Operator / Sealed Secrets) manage

ingress:
  enabled: true
  hosts:
    - host: schema-builder.example.org
      paths: [{ path: /, pathType: Prefix }]
```

Everything else in `values.yaml` has a default matching `docker-compose.yml`
and `.env.example`; see the comments there and this repo's root `README.md`
("Authentication" / "Storage" / "Observability") for what each one does.

### `database.url` vs `database.existingSecret`

`database.existingSecret` is the intended path for a GitOps/ArgoCD setup:
point it at a Secret provisioned out-of-band (External Secrets Operator,
Sealed Secrets, Vault, or just `kubectl create secret` once by hand) so the
connection string is never committed as plain Helm values.

`database.url` exists for quick, non-GitOps testing (`helm install` with
`--set database.url=...`). If you use it, note that the Secret this chart
creates is *also* a Helm hook (see `templates/secret.yaml`'s comment for
why: the migrate Job is itself a pre-install hook, and needs the Secret to
already exist) — which means `helm uninstall` does not clean it up. That's a
known, accepted trade-off for this path; prefer `existingSecret` in any
environment you care about tidying up after.

## Migrations

`<release>-migrate` is a `pre-install,pre-upgrade` Helm hook Job running
`node api/dist/scripts/migrate.js` — the same schema migration
`docker-compose.yml`'s `migrate` service runs, applied before any new `api`
Pod starts so N replicas never race applying the same migration. ArgoCD
converts these hook annotations into its own sync-wave hooks automatically.

## Health checks

Both probes hit `GET /api/v1/health` (`api/src/routes/v1/health.ts`) —
unauthenticated, and only proof the process is up, not that it can reach
Postgres or Keycloak. Treat a "Ready" Pod during a dependency outage as
best-effort, not a guarantee.

## Reasoning resource sizing

The `/api/v1/reason` endpoint shells out to ROBOT (a JVM, baked into the
image) with a 2 GiB heap, one at a time by default
(`REASONER_MAX_CONCURRENT=1`, `api/src/config/reasoner.ts`). The default
`resources.limits.memory` leaves headroom for that — lowering it risks an
OOM-kill mid-reasoning-request rather than a clean failure of just that
request.
