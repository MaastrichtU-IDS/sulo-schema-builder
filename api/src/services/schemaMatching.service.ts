import type { FastifyInstance } from 'fastify';
import { fetchFullSchema, type FullOntologyClass, type FullOntologyProperty, type FullOntologySchema, type FullTripleTemplate } from './schema.service.js';

const SULO = 'https://w3id.org/sulo/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function categoryOf(iriStr?: string): string | null {
  return iriStr && iriStr.startsWith(SULO) ? iriStr.slice(SULO.length) : null;
}

// ─── Resolvers: class category (via superClass chain) + range + shape ──────

interface RangeInfo {
  kind: 'datatype' | 'class' | 'sulo-upper' | 'other' | 'none';
  name?: string;
  cls?: FullOntologyClass;
  category?: string | null;
}

class SchemaResolvers {
  classById = new Map<string, FullOntologyClass>();
  classByUrl = new Map<string, FullOntologyClass>();

  constructor(schema: FullOntologySchema) {
    for (const c of schema.classes) {
      this.classById.set(c.id, c);
      this.classByUrl.set(c.url, c);
    }
  }

  classCategory(cls?: FullOntologyClass): string | null {
    let c = cls;
    const seen = new Set<string>();
    while (c && !c.mapsToConceptIri && c.superClassId && !seen.has(c.id)) {
      seen.add(c.id);
      c = this.classById.get(c.superClassId);
    }
    return c ? categoryOf(c.mapsToConceptIri) : null;
  }

  resolveRange(rangeClassIri?: string): RangeInfo {
    if (!rangeClassIri) return { kind: 'none' };
    if (rangeClassIri.startsWith(XSD)) return { kind: 'datatype', name: rangeClassIri.slice(XSD.length) };
    const localCls = this.classByUrl.get(rangeClassIri);
    if (localCls) return { kind: 'class', cls: localCls, category: this.classCategory(localCls) };
    const cat = categoryOf(rangeClassIri);
    if (cat) return { kind: 'sulo-upper', name: cat, category: cat };
    return { kind: 'other', name: rangeClassIri };
  }

  shapeOf(pattern: FullTripleTemplate[]): string {
    if (!pattern || !pattern.length) return '(none)';
    const shortPred = (p: string) => (p.startsWith(SULO) ? p.slice(SULO.length) : p === RDF_TYPE ? 'a' : p);
    if (pattern.length === 1) return shortPred(pattern[0].predicate);
    if (pattern.length === 3) {
      const p1 = shortPred(pattern[0].predicate);
      const p3 = shortPred(pattern[2].predicate);
      const typeObj = pattern[1].object;
      const localCls = this.classByUrl.get(typeObj);
      const cat = localCls ? this.classCategory(localCls) : categoryOf(typeObj);
      return `${p1}>[${cat || typeObj}]>${p3}`;
    }
    return pattern.map((t) => shortPred(t.predicate)).join('>');
  }
}

export interface DescribedProperty {
  schemaId: string;
  className: string;
  propertyId: string;
  propertyName: string;
  propertyLabel?: string;
  propertyType: 'object' | 'datatype';
  domainCategory: string | null;
  rangeDescription: string;
  rangeCategory: string | null;
  shape: string;
}

function describeProp(resolvers: SchemaResolvers, schemaId: string, prop: FullOntologyProperty): DescribedProperty {
  const domainCls = prop.domainClassId ? resolvers.classById.get(prop.domainClassId) : undefined;
  const domainCategory = resolvers.classCategory(domainCls);
  const range = resolvers.resolveRange(prop.rangeClassIri);
  const rangeCategory = range.kind === 'datatype' ? `xsd:${range.name}` : (range.category ?? range.name ?? null);
  const rangeDescription =
    range.kind === 'datatype' ? `xsd:${range.name}`
    : range.kind === 'class' ? `${range.cls!.name} (${range.category})`
    : range.kind === 'sulo-upper' ? `sulo:${range.name}`
    : (range.name ?? '(none)');

  return {
    schemaId,
    className: domainCls?.name ?? '(unknown)',
    propertyId: prop.id,
    propertyName: prop.name,
    propertyLabel: prop.label,
    propertyType: prop.propertyType,
    domainCategory,
    rangeDescription,
    rangeCategory,
    shape: resolvers.shapeOf(prop.mappingPattern),
  };
}

function matchKey(p: DescribedProperty): string {
  const shapeGeneric = p.shape.replace(/\[[A-Za-z]+\]/g, '[*]');
  return `${p.domainCategory}::${shapeGeneric}::${p.rangeCategory}`;
}

export interface MatchGroup {
  key: string;
  domainCategory: string | null;
  shape: string;
  rangeCategory: string | null;
  source: DescribedProperty[];
  target: DescribedProperty[];
}

export interface MatchReport {
  sourceSchema: { id: string; title: string };
  targetSchema: { id: string; title: string };
  matched: MatchGroup[];
  sourceOnly: MatchGroup[];
  targetOnly: MatchGroup[];
}

function filterByClassNames(schema: FullOntologySchema, classNames?: string[]): FullOntologyProperty[] {
  if (!classNames || !classNames.length) return schema.properties;
  const ids = new Set(schema.classes.filter((c) => classNames.includes(c.name)).map((c) => c.id));
  return schema.properties.filter((p) => p.domainClassId && ids.has(p.domainClassId));
}

/**
 * The core of "does SULO tell us these two schemas' fields correspond":
 * describe every property of both schemas as (domain category, generalized
 * predicate-chain shape, range category/datatype), then group by that key.
 * A key with entries on both sides is a checked structural correspondence,
 * not a name-based guess — this is exactly the manual process used to
 * compare the OMOP CDM Schema and MIMIC-IV FHIR Demo Schema, made reusable
 * for any two schemas in the app.
 */
export async function compareSchemas(
  fastify: FastifyInstance,
  sourceSchemaId: string,
  targetSchemaId: string,
  sourceClassNames?: string[],
  targetClassNames?: string[],
): Promise<MatchReport | null> {
  const [sourceSchema, targetSchema] = await Promise.all([
    fetchFullSchema(fastify, sourceSchemaId),
    fetchFullSchema(fastify, targetSchemaId),
  ]);
  if (!sourceSchema || !targetSchema) return null;

  const sourceR = new SchemaResolvers(sourceSchema);
  const targetR = new SchemaResolvers(targetSchema);

  const sourceProps = filterByClassNames(sourceSchema, sourceClassNames).map((p) => describeProp(sourceR, sourceSchema.id, p));
  const targetProps = filterByClassNames(targetSchema, targetClassNames).map((p) => describeProp(targetR, targetSchema.id, p));

  const byKey = new Map<string, MatchGroup>();
  function bucket(p: DescribedProperty, side: 'source' | 'target') {
    const key = matchKey(p);
    let group = byKey.get(key);
    if (!group) {
      group = { key, domainCategory: p.domainCategory, shape: p.shape.replace(/\[[A-Za-z]+\]/g, '[*]'), rangeCategory: p.rangeCategory, source: [], target: [] };
      byKey.set(key, group);
    }
    group[side].push(p);
  }
  for (const p of sourceProps) bucket(p, 'source');
  for (const p of targetProps) bucket(p, 'target');

  const matched: MatchGroup[] = [];
  const sourceOnly: MatchGroup[] = [];
  const targetOnly: MatchGroup[] = [];
  for (const group of byKey.values()) {
    if (group.source.length && group.target.length) matched.push(group);
    else if (group.source.length) sourceOnly.push(group);
    else targetOnly.push(group);
  }

  const byKeyName = (a: MatchGroup, b: MatchGroup) => a.key.localeCompare(b.key);
  matched.sort(byKeyName);
  sourceOnly.sort(byKeyName);
  targetOnly.sort(byKeyName);

  return {
    sourceSchema: { id: sourceSchema.id, title: sourceSchema.title },
    targetSchema: { id: targetSchema.id, title: targetSchema.title },
    matched,
    sourceOnly,
    targetOnly,
  };
}

// ─── Draft YAML generation (ops.py vocabulary — see sulo-schema-builder/etl) ──

function yamlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Renders a MatchReport as a draft mappings/*.yaml compatible with the
 * etl/transforms/ops.py interpreter in this repo. Automates the mechanical
 * op choice (reference/copy/coding_list) from each matched property's own
 * type+range; deliberately does NOT guess at composite ops (value_branch,
 * range) or real FHIR JSON path names — both need a human, and are left as
 * TODO comments rather than silently wrong output. See etl/mappings/*.yaml
 * for hand-finished examples of taking this draft the rest of the way.
 */
export function generateDraftYaml(report: MatchReport): string {
  const lines: string[] = [];
  lines.push(`# DRAFT — generated by SULO shape-matching ${report.sourceSchema.title} against ${report.targetSchema.title}.`);
  lines.push('# Every entry below is a checked SULO-shape correspondence; every "REVIEW"/"TODO"');
  lines.push('# comment marks something that could NOT be decided from ontology structure alone —');
  lines.push('# see etl/mappings/*.yaml and etl/README.md in the ETL scaffold for the op vocabulary');
  lines.push('# these compile to, and worked examples of finishing a draft like this one by hand.');
  lines.push('ops:');

  const claimedSource = new Set<string>();

  for (const group of report.matched) {
    const targetLabel = group.target[0];
    const domainLabel = `${targetLabel.className}.${targetLabel.propertyName}`;

    if (group.source.length > 1) {
      lines.push(`  # REVIEW: ${group.source.length} source candidates share this shape for ${domainLabel} — pick/merge manually:`);
      for (const c of group.source) lines.push(`  #   - ${c.className}.${c.propertyName}`);
    }
    const chosen = group.source.find((c) => !claimedSource.has(c.propertyId)) ?? group.source[0];
    claimedSource.add(chosen.propertyId);

    const isCodeCarrier = targetLabel.rangeDescription.startsWith('Code ');
    const isReference = targetLabel.propertyType === 'object' && targetLabel.rangeCategory !== 'Quality' && !isCodeCarrier;

    if (isCodeCarrier) {
      lines.push(`  - op: coding_list`);
      lines.push(`    target: ${yamlStr(targetLabel.propertyName)}  # TODO-PATH: real target JSON path`);
      lines.push(`    items:`);
      lines.push(`      - concept_from: ${chosen.propertyName}  # TODO: real source column/field name`);
    } else if (isReference) {
      lines.push(`  - op: reference`);
      lines.push(`    source: ${chosen.propertyName}  # TODO: real source column/field name`);
      lines.push(`    target: ${yamlStr(targetLabel.propertyName)}  # TODO-PATH: real target JSON path`);
      lines.push(`    prefix: ${yamlStr(`${targetLabel.rangeDescription.split(' ')[0]}/`)}`);
    } else if (targetLabel.propertyType === 'datatype') {
      lines.push(`  - op: copy`);
      lines.push(`    source: ${chosen.propertyName}  # TODO: real source column/field name`);
      lines.push(`    target: ${yamlStr(targetLabel.propertyName)}  # TODO-PATH: real target JSON path`);
    } else {
      lines.push(`  # TODO: no simple op fits ${domainLabel} (range ${targetLabel.rangeDescription}) — needs value_branch/range/manual op`);
      lines.push(`  #   candidate source: ${chosen.className}.${chosen.propertyName}`);
    }
    lines.push(`    sulo_shape: ${yamlStr(`${group.domainCategory}::${group.shape}::${group.rangeCategory}`)}`);
    lines.push('');
  }

  for (const group of report.targetOnly) {
    for (const t of group.target) {
      lines.push(`  - op: drop_target`);
      lines.push(`    target: ${yamlStr(t.propertyName)}  # TODO-PATH: real target JSON path for ${t.className}.${t.propertyName}`);
      lines.push(`    reason: ${yamlStr(`No source property shares this shape (${group.shape} :: ${group.rangeCategory}) — target-only field.`)}`);
      lines.push('');
    }
  }

  for (const group of report.sourceOnly) {
    for (const s of group.source) {
      if (claimedSource.has(s.propertyId)) continue;
      lines.push(`  - op: drop_source`);
      lines.push(`    source: ${s.propertyName}  # TODO: real source column/field name`);
      lines.push(`    reason: ${yamlStr(`No target property shares this shape (${group.shape} :: ${group.rangeCategory}) on the target side.`)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
