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
