// Zod schemas for the schema/class/property forms.
//
// Extracted from OntologyBuilderPage so the validation rules can be unit-tested
// without importing React. These are the client-side gate on user input
// (name format, required fields, URL shape) before requests hit the API.
import { z } from 'zod';

export const NewSchemaFormSchema = z.object({
  title: z.string().min(1, 'Ontology title is required'),
  description: z.string().optional(),
  upperOntologyIri: z.string().url('Must be a valid URL').or(z.literal('')).optional(),
});

export const EditSchemaFormSchema = z.object({
  title: z.string().min(1, 'Ontology title is required'),
  description: z.string().optional(),
  upperOntologyIri: z.string().url('Must be a valid URL').or(z.literal('')).optional(),
});

export const NewClassFormSchema = z.object({
  name: z.string().min(1, 'Name is required').regex(/^\S+$/, 'No spaces allowed'),
  label: z.string().optional(),
  description: z.string().optional(),
  // Accept any string — the combobox guides users to valid IRIs, no URL check needed here
  mapsToConceptIri: z.string().optional(),
  superClassId: z.string().optional(),
});

export const TripleTemplateSchema = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
});

export const NewPropertyFormSchema = z.object({
  name: z.string().min(1, 'Name is required').regex(/^\S+$/, 'No spaces allowed'),
  label: z.string().optional(),
  description: z.string().optional(),
  propertyType: z.enum(['object', 'datatype']),
  domainClassId: z.string().min(1, 'Domain class is required'),
  rangeClassIri: z.string().optional(),
  mappingPattern: z.array(TripleTemplateSchema).optional(),
  regexPattern: z.string().optional(),
  regexVariable: z.string().optional(),
  isRequired: z.boolean(),
  propertyFeatures: z.array(z.string()).optional(),
  inversePropertyIri: z.string().optional(),
  disjointPropertyIris: z.array(z.string()).optional(),
});

export type NewSchemaForm   = z.infer<typeof NewSchemaFormSchema>;
export type EditSchemaForm  = z.infer<typeof EditSchemaFormSchema>;
export type NewClassForm    = z.infer<typeof NewClassFormSchema>;
export type NewPropertyForm = z.infer<typeof NewPropertyFormSchema>;
