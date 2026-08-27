-- Keycloak needs its own database (separate from the app's `sulo` tables).
-- Postgres' entrypoint only runs files in /docker-entrypoint-initdb.d/ the
-- first time a data directory is initialized, i.e. only against a fresh
-- volume. If the `sulo-db` volume already exists from before this file was
-- added, this script will NOT run — either `docker compose down -v` to
-- recreate the volume, or create the database manually:
--   docker compose exec db psql -U sulo -d sulo -c "CREATE DATABASE keycloak OWNER sulo;"
CREATE DATABASE keycloak OWNER sulo;
