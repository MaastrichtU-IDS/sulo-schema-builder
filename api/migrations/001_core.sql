create extension if not exists pgcrypto;

create table users (
  id           uuid primary key default gen_random_uuid(),
  subject      text unique not null,
  email        text,
  display_name text,
  orcid        text,
  global_role  text not null default 'user'  check (global_role in ('user','moderator','admin')),
  quota_tier   text not null default 'free'  check (quota_tier in ('free','verified','staff')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create table reasoning_reports (
  cache_key   text primary key,
  report      jsonb not null,
  reasoner    text not null,
  sulo_hash   text not null,
  duration_ms integer,
  created_at  timestamptz not null default now()
);

create table schemas (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references users(id) on delete cascade,
  title              text not null,
  description        text,
  upper_ontology_iri text,
  base_uri           text,
  visibility         text not null default 'private'
                     check (visibility in ('private','unlisted','public')),
  content_hash       text,
  latest_report_key  text references reasoning_reports(cache_key) on delete set null,
  reason_state       text not null default 'stale'
                     check (reason_state in ('stale','queued','running','fresh','failed')),
  created_at         timestamptz not null default now(),
  modified_at        timestamptz not null default now()
);
create index schemas_owner_idx on schemas (owner_id);
create index schemas_public_idx on schemas (visibility) where visibility = 'public';

create table classes (
  id                  uuid primary key default gen_random_uuid(),
  schema_id           uuid not null references schemas(id) on delete cascade,
  name                text not null,
  label               text,
  description         text,
  maps_to_concept_iri text,
  super_class_id      uuid references classes(id) on delete set null
);
create index classes_schema_idx on classes (schema_id);

create table properties (
  id                     uuid primary key default gen_random_uuid(),
  schema_id              uuid not null references schemas(id) on delete cascade,
  name                   text not null,
  label                  text,
  description            text,
  property_type          text not null default 'datatype'
                         check (property_type in ('object','datatype')),
  domain_class_id        uuid references classes(id) on delete set null,
  range_class_iri        text,
  mapping_pattern        jsonb,
  regex_pattern          text,
  regex_variable         text,
  is_required            boolean not null default false,
  property_features      jsonb,
  inverse_property_iri   text,
  disjoint_property_iris jsonb
);
create index properties_schema_idx on properties (schema_id);

create table schema_grants (
  schema_id  uuid references schemas(id) on delete cascade,
  grantee_id uuid references users(id)   on delete cascade,
  role       text not null check (role in ('viewer','editor','owner')),
  granted_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (schema_id, grantee_id)
);

create table reason_jobs (
  id           bigserial primary key,
  schema_id    uuid not null references schemas(id) on delete cascade,
  requested_by uuid references users(id) on delete set null,
  cache_key    text not null,
  state        text not null check (state in ('queued','running','done','failed')),
  attempts     integer not null default 0,
  enqueued_at  timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text
);
create unique index reason_jobs_one_active_per_schema
  on reason_jobs (schema_id) where state in ('queued','running');

create table usage_events (
  id         bigserial primary key,
  user_id    uuid references users(id) on delete set null,
  kind       text not null,
  schema_id  uuid,
  cost_ms    integer,
  cache_hit  boolean not null default false,
  created_at timestamptz not null default now()
);
create index usage_events_user_time_idx on usage_events (user_id, created_at desc);
