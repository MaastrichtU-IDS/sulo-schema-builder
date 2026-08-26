#!/bin/sh
# Creates (or repairs) three deterministic Keycloak users for the e2e suite to
# sign in as through Keycloak's own hosted login page: "Alice"
# (frontend/e2e/auth-flow.spec.ts and frontend/e2e/sharing-flow.spec.ts),
# "Bob" (frontend/e2e/sharing-flow.spec.ts, added for the two-account
# isolation/sharing proof) and "Carol" (frontend/e2e/events-flow.spec.ts,
# the admin identity for that spec's tier-change assertion — see her own
# seed_user call below for why ci.yml promotes her to admin from THIS
# script's stdout rather than after the fact). Model: configure-idps.sh in
# this directory.
#
# LOCAL AND CI USE ONLY. The passwords below are fixed and committed to this
# repo — never run this against a realm that is reachable from anywhere but
# a throwaway dev/CI Keycloak.
#
# The realm sets registrationEmailAsUsername and verifyEmail (see
# realm-sulo.json), so a user created without emailVerified, firstName and
# lastName gets stuck behind Keycloak's VERIFY_PROFILE required action on
# first login instead of ever reaching the app. A previous manual seeding
# attempt hit exactly that. seed_user() below sets all three explicitly and
# re-applies them on every run, so a partially-seeded user left over from an
# earlier failed attempt gets repaired rather than staying broken.
#
# Idempotent: safe to re-run against a realm that already has either user.
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

"$KC" config credentials --server "$KC_URL" --realm master --user "$KC_ADMIN" --password "$KC_ADMIN_PASSWORD"

# Creates (or repairs) one deterministic user. Factored out so the two
# accounts below cannot drift apart on the emailVerified/firstName/lastName
# fix — see the header comment for why all three matter on every run, not
# only at creation.
seed_user() {
  email="$1"
  password="$2"
  first_name="$3"
  last_name="$4"

  user_id=$("$KC" get users -r "$REALM" -q "email=$email" --format csv --noquotes -F id | head -n1)

  if [ -z "$user_id" ]; then
    echo "creating $email"
    user_id=$("$KC" create users -r "$REALM" \
      -s username="$email" \
      -s email="$email" \
      -s emailVerified=true \
      -s enabled=true \
      -s firstName="$first_name" \
      -s lastName="$last_name" \
      -i)
  else
    echo "$email already exists ($user_id); re-applying required fields"
    "$KC" update "users/$user_id" -r "$REALM" \
      -s emailVerified=true \
      -s enabled=true \
      -s firstName="$first_name" \
      -s lastName="$last_name" \
      -s 'requiredActions=[]'
  fi

  "$KC" set-password -r "$REALM" --userid "$user_id" --new-password "$password" --temporary=false
  echo "seeded $email"
}

# "Alice". Must match the credentials frontend/e2e/auth-flow.spec.ts and
# frontend/e2e/sharing-flow.spec.ts drive through Keycloak's login form.
seed_user "${E2E_USER_EMAIL:-e2e@example.org}" "${E2E_USER_PASSWORD:-E2ePassw0rd!}" "E2E" "Tester"

# "Bob" — only frontend/e2e/sharing-flow.spec.ts signs in as this account.
# A second real identity is what makes that spec's owner-scoping and sharing
# assertions load-bearing against the server, rather than against the UI's
# own sign-out gate (see that spec's header comment).
seed_user "${E2E_USER2_EMAIL:-e2e-bob@example.org}" "${E2E_USER2_PASSWORD:-E2eBobPassw0rd!}" "E2E" "Bob"

# "Carol" — only frontend/e2e/events-flow.spec.ts signs in as this account,
# to exercise a real admin route (PATCH /admin/users/:id) end to end.
seed_user "${E2E_USER3_EMAIL:-e2e-carol@example.org}" "${E2E_USER3_PASSWORD:-E2eCarolPassw0rd!}" "E2E" "Carol"

# Printed last, in the one machine-parseable line ci.yml's seeding step
# greps out of this script's stdout: Carol's Keycloak user id, which IS the
# `sub` claim her tokens carry (Keycloak stamps `sub` with the user's own
# id) — the same value the `users.subject` column keys off. ci.yml uses it
# to insert Carol into Postgres with global_role='admin' BEFORE her first
# sign-in reaches the API, not after: users/repo.ts's upsertBySubject never
# touches global_role on conflict specifically so a promotion survives a
# later sign-in, but "later" has to mean later than THIS insert — done
# after, Carol's own real default 60s subject->user cache entry (plugins/
# auth.ts) would leave the promotion invisible to her own next request for
# up to a minute, exactly the effect admin.test.ts's own cache test pins
# down. $user_id is left set by seed_user above (POSIX sh has no function
# scoping), so this is Carol's, not Bob's.
echo "CAROL_ID=$user_id"
