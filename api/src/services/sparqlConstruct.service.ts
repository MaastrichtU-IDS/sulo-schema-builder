// Compiles a schema property's own mapping pattern (already stored in the
// tool — the same TripleTemplate[] ontologyExport.ts turns into OWL
// restrictions) directly into executable SPARQL CONSTRUCT queries instead.
//
// No new specification format, no separate authoring step: a property's
// forward/reverse fold is auto-derived from data the tool already has.
// Adapted from an independent hackathon exploration of the same repo
// (`feat/data-transformation`, 2026-07-24), which established — via
// refutation-based entailment probes against HermiT — that OWL DL reasoning
// can classify instances but can never materialize an instance edge nor fold
// a property chain back into a flat triple in the reverse direction; SPARQL
// CONSTRUCT is the mechanism that actually performs the transformation the
// mapping patterns describe.
import type { FullOntologyProperty, FullOntologySchema, FullTripleTemplate } from './schema.service.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SULO_NS = 'https://w3id.org/sulo/';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';

// ─── value transforms ───────────────────────────────────────────────────────
// Applied only on the source→target bridge direction: two independently
// designed schemas frequently agree on WHAT a value means (shape-matched)
// but disagree on its literal form — a plain string vs. xsd:dateTime, a
// coded value with a vocabulary prefix, upper- vs. lower-case enums, etc.
// Each variant below maps to one real SPARQL 1.1 built-in, so the emitted
// BIND is directly executable — no bespoke transform runtime to maintain.
export type XsdCastType = 'string' | 'integer' | 'decimal' | 'double' | 'float' | 'boolean' | 'dateTime' | 'date';

export type ValueTransform =
  | { kind: 'none' }
  | { kind: 'cast'; datatype: XsdCastType }
  | { kind: 'concatPrefix'; text: string }
  | { kind: 'concatSuffix'; text: string }
  | { kind: 'splitBefore'; delimiter: string }
  | { kind: 'splitAfter'; delimiter: string }
  | { kind: 'uppercase' }
  | { kind: 'lowercase' }
  | { kind: 'substring'; start: number; length?: number }
  | { kind: 'replace'; pattern: string; replacement: string };

function sparqlStringLiteral(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Renders a transform as a SPARQL expression over `valueVar` (e.g. "?value"). */
export function renderTransformExpr(transform: ValueTransform | undefined, valueVar: string): string {
  if (!transform || transform.kind === 'none') return valueVar;
  const str = `STR(${valueVar})`;
  switch (transform.kind) {
    case 'cast':
      return `<${XSD_NS}${transform.datatype}>(${valueVar})`;
    case 'concatPrefix':
      return `CONCAT(${sparqlStringLiteral(transform.text)}, ${str})`;
    case 'concatSuffix':
      return `CONCAT(${str}, ${sparqlStringLiteral(transform.text)})`;
    case 'splitBefore':
      return `STRBEFORE(${str}, ${sparqlStringLiteral(transform.delimiter)})`;
    case 'splitAfter':
      return `STRAFTER(${str}, ${sparqlStringLiteral(transform.delimiter)})`;
    case 'uppercase':
      return `UCASE(${str})`;
    case 'lowercase':
      return `LCASE(${str})`;
    case 'substring':
      return transform.length != null
        ? `SUBSTR(${str}, ${transform.start}, ${transform.length})`
        : `SUBSTR(${str}, ${transform.start})`;
    case 'replace':
      return `REPLACE(${str}, ${sparqlStringLiteral(transform.pattern)}, ${sparqlStringLiteral(transform.replacement)})`;
  }
}

export function schemaBase(schema: FullOntologySchema): string {
  return schema.url.endsWith('/') ? schema.url : schema.url + '/';
}

// Class url -> canonical full IRI: an external concept (e.g. a SNOMED code)
// is used directly; a class mapped only to a bare SULO category falls back
// to the schema-local name-based IRI (the same one the OWL/SHACL export uses).
export function classIriMap(schema: FullOntologySchema): Map<string, string> {
  const base = schemaBase(schema);
  return new Map(
    schema.classes.map((c) => [
      c.url,
      c.mapsToConceptIri && !c.mapsToConceptIri.startsWith(SULO_NS) ? c.mapsToConceptIri : `${base}${c.name}`,
    ]),
  );
}

const ivar = (v: string) => `?i_${v.slice(1)}`;

function renderTerm(o: string, cm: Map<string, string>): string {
  if (o === '?this' || o === '?value') return o;
  if (o.startsWith('?')) return ivar(o);
  return `<${cm.get(o) ?? o}>`;
}

function renderTemplate(t: FullTripleTemplate, cm: Map<string, string>): string {
  const s = renderTerm(t.subject, cm);
  if (t.predicate === RDF_TYPE) return `  ${s} a ${renderTerm(t.object, cm)} .`;
  return `  ${s} <${t.predicate}> ${renderTerm(t.object, cm)} .`;
}

function intermediateVars(pattern: FullTripleTemplate[]): string[] {
  const vars = new Set<string>();
  for (const t of pattern) {
    for (const term of [t.subject, t.object]) {
      if (term.startsWith('?') && term !== '?this' && term !== '?value') vars.add(term);
    }
  }
  return [...vars];
}

/** Flat schema triple -> unfolded SULO subgraph (skolemized intermediate nodes). */
export function buildForwardConstruct(prop: FullOntologyProperty, schema: FullOntologySchema): string | null {
  if (prop.mappingPattern.length === 0 || !prop.domainClassId) return null;
  const cm = classIriMap(schema);
  const base = schemaBase(schema);
  const dom = schema.classes.find((c) => c.id === prop.domainClassId);
  if (!dom) return null;

  const propIri = `${base}${prop.name}`;
  const construct = prop.mappingPattern.map((t) => renderTemplate(t, cm));
  const binds = intermediateVars(prop.mappingPattern).map(
    (v) =>
      `  BIND(IRI(CONCAT("${base}skolem/", ` +
      `MD5(CONCAT(STR(?this), "|${prop.name}|${v.slice(1)}|", STR(?value))))) AS ${ivar(v)})`,
  );

  return [
    'CONSTRUCT {',
    ...construct,
    '}',
    'WHERE {',
    `  ?this a <${cm.get(dom.url)}> ;`,
    `        <${propIri}> ?value .`,
    ...binds,
    '}',
  ].join('\n');
}

/** SULO subgraph -> flat schema triple (+ domain retag). */
export function buildReverseConstruct(prop: FullOntologyProperty, schema: FullOntologySchema): string | null {
  if (prop.mappingPattern.length === 0 || !prop.domainClassId) return null;
  const cm = classIriMap(schema);
  const base = schemaBase(schema);
  const dom = schema.classes.find((c) => c.id === prop.domainClassId);
  if (!dom) return null;

  return [
    'CONSTRUCT {',
    `  ?this <${base}${prop.name}> ?value .`,
    `  ?this a <${cm.get(dom.url)}> .`,
    '}',
    'WHERE {',
    ...prop.mappingPattern.map((t) => renderTemplate(t, cm)),
    '}',
  ].join('\n');
}

/** Direct A-flat -> B-flat query for one user-confirmed property pair.
 *  An optional transform (type cast, split, concatenate, ...) is applied to
 *  ?value before it is asserted on the target side — see renderTransformExpr. */
export function buildBridgeConstruct(
  pa: FullOntologyProperty,
  a: FullOntologySchema,
  pb: FullOntologyProperty,
  b: FullOntologySchema,
  transform?: ValueTransform,
): string | null {
  if (!pa.domainClassId || !pb.domainClassId) return null;
  const cmA = classIriMap(a);
  const cmB = classIriMap(b);
  const domA = a.classes.find((c) => c.id === pa.domainClassId);
  const domB = b.classes.find((c) => c.id === pb.domainClassId);
  if (!domA || !domB) return null;

  const expr = renderTransformExpr(transform, '?value');
  const outVar = expr === '?value' ? '?value' : '?transformed';

  return [
    'CONSTRUCT {',
    `  ?this <${schemaBase(b)}${pb.name}> ${outVar} .`,
    `  ?this a <${cmB.get(domB.url)}> .`,
    '}',
    'WHERE {',
    `  ?this a <${cmA.get(domA.url)}> ;`,
    `        <${schemaBase(a)}${pa.name}> ?value .`,
    ...(outVar === '?value' ? [] : [`  BIND(${expr} AS ${outVar})`]),
    '}',
  ].join('\n');
}
