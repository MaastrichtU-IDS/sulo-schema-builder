CREATE TABLE IF NOT EXISTS schemas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  upper_ontology_iri TEXT,
  -- Overrides the auto-generated ontology-schema/{id} namespace: when set,
  -- every class/property IRI this schema mints resolves under this prefix
  -- instead. Normalized to end in '/' or '#' on write.
  base_uri TEXT,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  schema_id TEXT NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT,
  description TEXT,
  maps_to_concept_iri TEXT,
  super_class_id TEXT REFERENCES classes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_classes_schema ON classes(schema_id);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  schema_id TEXT NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT,
  description TEXT,
  property_type TEXT NOT NULL DEFAULT 'datatype' CHECK (property_type IN ('object', 'datatype')),
  domain_class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  range_class_iri TEXT,
  mapping_pattern TEXT,
  regex_pattern TEXT,
  regex_variable TEXT,
  is_required INTEGER NOT NULL DEFAULT 0,
  property_features TEXT,
  inverse_property_iri TEXT,
  disjoint_property_iris TEXT
);
CREATE INDEX IF NOT EXISTS idx_properties_schema ON properties(schema_id);

-- Small key/value store for app-level state that isn't part of any schema:
-- the user-supplied Java path, and the timestamp of the last SULO update check.
-- New tables (unlike new columns) need no migration helper — the IF NOT EXISTS
-- above runs against existing databases on every open.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
