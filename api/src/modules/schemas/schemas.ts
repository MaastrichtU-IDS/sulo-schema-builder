import { z } from 'zod';

export const CreateOntologySchemaBody = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  upperOntologyIri: z.string().url().optional(),
  // Overrides the auto-generated ontology-schema/{id} namespace: when set,
  // every class/property IRI this schema mints (:ClassName, :propertyName)
  // resolves under this prefix instead. Must end in '/' or '#' for exports
  // to concatenate a local name onto it correctly — normalized on write.
  baseUri: z.string().url().optional(),
});

export const UpdateOntologySchemaBody = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  upperOntologyIri: z.string().url().optional(),
  baseUri: z.string().url().optional(),
});

export const AddClassBody = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  mapsToConceptIri: z.string().url().optional(),
  superClassId: z.string().optional(),   // UUID of the parent class within this schema
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
  domainClassId: z.string().optional(),
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
  superClassId: z.string().optional(),        // '' = remove superclass
});

export const UpdatePropertyBody = z.object({
  name: z.string().min(1).optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  propertyType: z.enum(['object', 'datatype']).optional(),
  domainClassId: z.string().optional(),
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
