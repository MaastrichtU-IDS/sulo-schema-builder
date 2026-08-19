// Request validators for the Postgres schemas module.
//
// These started as a verbatim copy of the frozen SQLite route's validators so
// the two storage modes could not drift. Two deliberate departures now exist,
// both because the frozen copy contradicted its own PATCH contract:
//
//  1. `ClearableUrl` — service.ts implements '' as "clear this nullable
//     column", but `z.string().url()` rejects '', so PATCH {"baseUri":""} used
//     to 400 and the clear path was unreachable. Both IRI fields now accept ''
//     explicitly (a non-empty non-URL is still rejected).
//  2. `ClassRef` — superClassId/domainClassId address a row in this schema's
//     `classes` table, whose ids are uuids in Postgres. Accepting a bare string
//     turned a typo into an invalid-uuid database error, i.e. a bare 500.
//     Non-uuid values are a client error and are named as such here.

import { z } from 'zod';

/** A URL, or '' meaning "clear this field" (see service.ts's `nullable`). */
const ClearableUrl = z.union([z.literal(''), z.string().url()]);

/** A uuid referencing a class in the *same* schema, or '' to clear it. */
const ClassRef = z.union([z.literal(''), z.string().uuid()]);

export const CreateOntologySchemaBody = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  upperOntologyIri: ClearableUrl.optional(),
  // Overrides the auto-generated ontology-schema/{id} namespace: when set,
  // every class/property IRI this schema mints (:ClassName, :propertyName)
  // resolves under this prefix instead. Must end in '/' or '#' for exports
  // to concatenate a local name onto it correctly — normalized on write.
  baseUri: ClearableUrl.optional(),
});

export const UpdateOntologySchemaBody = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  upperOntologyIri: ClearableUrl.optional(),
  baseUri: ClearableUrl.optional(),
});

export const AddClassBody = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  mapsToConceptIri: z.string().url().optional(),
  // Verified to resolve inside this schema by service.addClass — an id from
  // another schema is a 400, not a cross-schema hierarchy edge.
  superClassId: ClassRef.optional(),
});

export const TripleTemplateBody = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
});

export const PropertyFeatureEnum = z.enum([
  'functional', 'inverseFunctional',
  'transitive', 'symmetric', 'asymmetric',
  'reflexive', 'irreflexive',
]);

export const AddPropertyBody = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  propertyType: z.enum(['object', 'datatype']).default('datatype'),
  domainClassId: ClassRef.optional(),   // same-schema check as superClassId
  rangeClassIri: z.string().optional(),
  mappingPattern: z.array(TripleTemplateBody).optional(),
  regexPattern: z.string().optional(),
  regexVariable: z.string().optional(),
  isRequired: z.boolean().default(false),
  propertyFeatures: z.array(PropertyFeatureEnum).optional(),
  inversePropertyIri: z.string().optional(),
  disjointPropertyIris: z.array(z.string()).optional(),
});

export const UpdateClassBody = z.object({
  name: z.string().min(1).optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  mapsToConceptIri: z.string().optional(),   // '' = remove mapping
  superClassId: ClassRef.optional(),          // '' = remove superclass
});

export const UpdatePropertyBody = z.object({
  name: z.string().min(1).optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  propertyType: z.enum(['object', 'datatype']).optional(),
  domainClassId: ClassRef.optional(),         // '' = remove domain
  rangeClassIri: z.string().optional(),
  mappingPattern: z.array(TripleTemplateBody).optional(),
  regexPattern: z.string().optional(),
  regexVariable: z.string().optional(),
  isRequired: z.boolean().optional(),
  propertyFeatures: z.array(PropertyFeatureEnum).optional(),
  inversePropertyIri: z.string().optional(),
  disjointPropertyIris: z.array(z.string()).optional(),
});

export const IdParam = z.object({ id: z.string().min(1) });
export const ClassIdParam = z.object({ id: z.string().min(1), classId: z.string().min(1) });
export const PropIdParam = z.object({ id: z.string().min(1), propId: z.string().min(1) });
