#!/bin/sh
# Creates (or repairs) a deterministic Keycloak user for the auth e2e suite
# (frontend/e2e/auth-flow.spec.ts) to sign in as through Keycloak's own
# hosted login page. Model: configure-idps.sh in this directory.
#
# LOCAL AND CI USE ONLY. The password below is fixed and committed to this
# repo — never run this against a realm that is reachable from anywhere but
# a throwaway dev/CI Keycloak.
#
# The realm sets registrationEmailAsUsername and verifyEmail (see
# realm-sulo.json), so a user created without emailVerified, firstName and
# lastName gets stuck behind Keycloak's VERIFY_PROFILE required action on
# first login instead of ever reaching the app. A previous manual seeding
# attempt hit exactly that. This script sets all three explicitly and
# re-applies them on every run, so a partially-seeded user left over from an
# earlier failed attempt gets repaired rather than staying broken.
#
# Idempotent: safe to re-run against a realm that already has the user.
# Run against a Keycloak that has already imported realm-sulo.json. Note
# `docker compose exec` does not forward host environment variables into the
# container on its own (verified against Docker Compose v5.3.1) — pass the
# admin credentials explicitly with `-e`, the same requirement configure-idps.sh
# has:
#
#   docker compose exec \
#     -e KEYCLOAK_ADMIN_PASSWORD=admin -e KEYCLOAK_ADMIN=admin \
#     keycloak sh /opt/keycloak/bin/seed-test-user.sh
#
set -eu

KC=/opt/keycloak/bin/kcadm.sh
KC_URL="${KC_URL:-http://localhost:8080}"
KC_ADMIN="${KEYCLOAK_ADMIN:-admin}"
KC_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD must be set}"
REALM=sulo

# Must match the credentials frontend/e2e/auth-flow.spec.ts drives through
# Keycloak's login form.
EMAIL="${E2E_USER_EMAIL:-e2e@example.org}"
PASSWORD="${E2E_USER_PASSWORD:-E2ePassw0rd!}"

"$KC" config credentials --server "$KC_URL" --realm master --user "$KC_ADMIN" --password "$KC_ADMIN_PASSWORD"

USER_ID=$("$KC" get users -r "$REALM" -q "email=$EMAIL" --format csv --noquotes -F id | head -n1)

if [ -z "$USER_ID" ]; then
  echo "creating $EMAIL"
  USER_ID=$("$KC" create users -r "$REALM" \
    -s username="$EMAIL" \
    -s email="$EMAIL" \
    -s emailVerified=true \
    -s enabled=true \
    -s firstName=E2E \
    -s lastName=Tester \
    -i)
else
  echo "$EMAIL already exists ($USER_ID); re-applying required fields"
  "$KC" update "users/$USER_ID" -r "$REALM" \
    -s emailVerified=true \
    -s enabled=true \
    -s firstName=E2E \
    -s lastName=Tester \
    -s 'requiredActions=[]'
fi

"$KC" set-password -r "$REALM" --userid "$USER_ID" --new-password "$PASSWORD" --temporary=false

echo "seeded $EMAIL"
