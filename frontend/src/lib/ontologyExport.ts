// Pure, React-free schema → RDF/OWL/SHACL/Mermaid export logic.
//
// Extracted from OntologyBuilderPage so it can be unit-tested without pulling
// in React, ReactFlow, or the rest of the page. Everything here is a pure
// function of its inputs (the one exception, generateExports, uses
// crypto.randomUUID() to mint blank-ish anchor IRIs for OWL equivalent-class
// axioms — those IRIs are non-deterministic but their structure is stable).

import type {
  OntologyClass,
  OntologyProperty,
  OntologySchema,
  TripleTemplate,
} from '../api/ontology.js';

// ─── Property characteristic metadata ────────────────────────────────────────

export const PROPERTY_FEATURE_OWL: Record<string, string> = {
  functional:        'owl:FunctionalProperty',
  inverseFunctional: 'owl:InverseFunctionalProperty',
  transitive:        'owl:TransitiveProperty',
  symmetric:         'owl:SymmetricProperty',
  asymmetric:        'owl:AsymmetricProperty',
  reflexive:         'owl:ReflexiveProperty',
  irreflexive:       'owl:IrreflexiveProperty',
};

export const PROPERTY_FEATURES_ALL = [
  { value: 'functional',        label: 'Functional',           desc: 'At most one value per subject',              appliesTo: 'both'   },
  { value: 'inverseFunctional', label: 'Inverse Functional',   desc: 'At most one subject per value',              appliesTo: 'object' },
  { value: 'transitive',        label: 'Transitive',           desc: 'If a→b and b→c then a→c',                   appliesTo: 'object' },
  { value: 'symmetric',         label: 'Symmetric',            desc: 'If a→b then b→a',                            appliesTo: 'object' },
  { value: 'asymmetric',        label: 'Asymmetric',           desc: 'If a→b then NOT b→a',                        appliesTo: 'object' },
  { value: 'reflexive',         label: 'Reflexive',            desc: 'Every individual relates to itself',         appliesTo: 'object' },
  { value: 'irreflexive',       label: 'Irreflexive',          desc: 'No individual relates to itself',            appliesTo: 'object' },
] as const;

// ─── Regex helpers ────────────────────────────────────────────────────────────

export function extractNamedGroups(pattern: string): string[] {
  const groups: string[] = [];
  const re = /\(\?<([^>]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern)) !== null) groups.push(m[1]);
  return groups;
}

// ─── Turtle helpers ─────────────────────────────────────────────────────────

export function escTtl(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function shortenIri(iri: string, pfxMap: Record<string, string>): string {
  for (const [pfx, ns] of Object.entries(pfxMap)) {
    if (iri.startsWith(ns)) {
      const local = iri.slice(ns.length);
      if (local && /^[A-Za-z_][\w.-]*$/.test(local)) {
        return pfx ? `${pfx}:${local}` : `:${local}`;
      }
    }
  }
  return `<${iri}>`;
}

export function turtleBlock(subject: string, pairs: [string, string][]): string {
  if (!pairs.length) return '';
  return [
    subject,
    ...pairs.map(([p, o], i) => `    ${p} ${o}${i < pairs.length - 1 ? ' ;' : ' .'}`),
  ].join('\n');
}

// Recursively build an OWL class expression from a triple mapping pattern.
// Type-assertion triples (?o rdf:type <IRI>) become intersection members.
// Property chains (?o pred ?next) become owl:someValuesFrom restrictions.
// The terminal ?value is replaced by terminalClassIri.
export function buildOwlExpr(
  subjectVar: string,
  pattern: TripleTemplate[],
  terminalClassIri: string,
  pfxMap: Record<string, string>,
  classMap: Map<string, string>,   // url → :LocalName for schema classes
  subjectClassIri?: string,        // optional: include this class as the type of the subject
): string {
  const RDF_TYPE  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const triples   = pattern.filter((t) => t.subject === subjectVar && t.predicate);
  const resolveIri = (iri: string) => classMap.get(iri) ?? shortenIri(iri, pfxMap);

  const typeMembers: string[] = subjectClassIri ? [resolveIri(subjectClassIri)] : [];
  const restrictions: string[] = [];

  for (const t of triples) {
    const pred = shortenIri(t.predicate, pfxMap);
    if (t.predicate === RDF_TYPE && !t.object.startsWith('?')) {
      typeMembers.push(resolveIri(t.object));
    } else if (t.object === '?value') {
      restrictions.push(`[ a owl:Restriction ; owl:onProperty ${pred} ; owl:someValuesFrom ${resolveIri(terminalClassIri)} ]`);
    } else if (t.object.startsWith('?')) {
      const inner = buildOwlExpr(t.object, pattern, terminalClassIri, pfxMap, classMap);
      restrictions.push(`[ a owl:Restriction ; owl:onProperty ${pred} ; owl:someValuesFrom ${inner} ]`);
    } else {
      typeMembers.push(resolveIri(t.object));
    }
  }

  const members = [...typeMembers, ...restrictions];
  if (members.length === 0) return 'owl:Thing';
  if (members.length === 1) return members[0];
  return `[ a owl:Class ; owl:intersectionOf ( ${members.join(' ')} ) ]`;
}

export function buildReverseOwlExpr(
  currentVar: string,         // current variable in the backward walk (start: '?value')
  pattern: TripleTemplate[],
  domainClassIri: string,     // IRI of the domain class (terminus of backward walk, reached via ?this)
  rangeClassIri: string,      // IRI of the range class (included at ?value start)
  pfxMap: Record<string, string>,
  classMap: Map<string, string>,
): string {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const resolveIri = (iri: string) => classMap.get(iri) ?? shortenIri(iri, pfxMap);

  const members: string[] = [];

  if (currentVar === '?value') {
    members.push(resolveIri(rangeClassIri));
  }

  // Forward rdf:type constraints on this variable
  for (const t of pattern) {
    if (t.subject === currentVar && t.predicate === RDF_TYPE && !t.object.startsWith('?')) {
      members.push(resolveIri(t.object));
    }
  }

  // Inverse restrictions: triples where this var appears as object
  for (const t of pattern) {
    if (t.object !== currentVar) continue;
    const pred = shortenIri(t.predicate, pfxMap);
    const inner = t.subject === '?this'
      ? resolveIri(domainClassIri)
      : buildReverseOwlExpr(t.subject, pattern, domainClassIri, rangeClassIri, pfxMap, classMap);
    members.push(`[ a owl:Restriction ; owl:onProperty [ owl:inverseOf ${pred} ] ; owl:someValuesFrom ${inner} ]`);
  }

  if (members.length === 0) return 'owl:Thing';
  if (members.length === 1) return members[0];
  return `[ a owl:Class ; owl:intersectionOf ( ${members.join(' ')} ) ]`;
}

export interface ExportResult { turtlePlain: string; turtleOwl: string; shaclTtl: string; }

export function generateExports(schema: OntologySchema): ExportResult {
  const base    = schema.url.endsWith('/') ? schema.url : schema.url + '/';
  const upperRaw = schema.upperOntologyIri ?? '';
  const upperNs  = upperRaw
    ? (upperRaw.endsWith('/') || upperRaw.endsWith('#') ? upperRaw : upperRaw + '/')
    : '';
  const upperPfx = upperNs
    ? (upperNs.replace(/[/#]+$/, '').split(/[/#]/).pop() ?? 'upper').toLowerCase()
    : '';

  const suloNs = 'https://w3id.org/sulo/';
  const hasSuloMappings = schema.classes.some((c) => c.mapsToConceptIri?.startsWith(suloNs));

  // Returns the canonical IRI for a class in exports:
  // classes whose mapsToConceptIri is a non-SULO external IRI (e.g. SNOMED) are identified
  // by that IRI; all others use the schema-local :ClassName.
  function extIri(cls: OntologyClass): string {
    if (cls.mapsToConceptIri && !cls.mapsToConceptIri.startsWith(suloNs)) {
      return `<${cls.mapsToConceptIri}>`;
    }
    return `:${cls.name}`;
  }

  // Map from class URL (UUID IRI) → canonical IRI string for use inside OWL expressions
  const classMap = new Map<string, string>(schema.classes.map((c) => [c.url, extIri(c)]));

  // Plain RDFS prefix map — no owl:
  const plainPfxMap: Record<string, string> = {
    '':    base,
    xsd:   'http://www.w3.org/2001/XMLSchema#',
    rdfs:  'http://www.w3.org/2000/01/rdf-schema#',
    dct:   'http://purl.org/dc/terms/',
  };
  if (upperPfx) plainPfxMap[upperPfx] = upperNs;

  // OWL prefix map — includes owl: and optionally sulo:
  const owlPfxMap: Record<string, string> = {
    '':    base,
    xsd:   'http://www.w3.org/2001/XMLSchema#',
    rdfs:  'http://www.w3.org/2000/01/rdf-schema#',
    owl:   'http://www.w3.org/2002/07/owl#',
    dct:   'http://purl.org/dc/terms/',
  };
  if (upperPfx) owlPfxMap[upperPfx] = upperNs;
  if (hasSuloMappings && !owlPfxMap['sulo']) owlPfxMap['sulo'] = suloNs;

  const propsByClass = new Map<string, OntologyProperty[]>();
  for (const prop of schema.properties) {
    const k = prop.domainClassId ?? '';
    if (!propsByClass.has(k)) propsByClass.set(k, []);
    propsByClass.get(k)!.push(prop);
  }

  // ── Turtle builder (shared for both variants) ────────────────────────────────
  function buildTurtle(pfxMap: Record<string, string>, includeSulo: boolean): string {
    const ttl: string[] = [];

    for (const [p, ns] of Object.entries(pfxMap)) ttl.push(`@prefix ${p}: <${ns}> .`);
    ttl.push('');

    const hdrPairs: [string, string][] = includeSulo
      ? [['a', 'owl:Ontology'], ['dct:title', `"${escTtl(schema.title)}"`]]
      : [['dct:title', `"${escTtl(schema.title)}"`]];
    if (schema.description) hdrPairs.push(['dct:description', `"${escTtl(schema.description)}"`]);
    if (includeSulo && hasSuloMappings) hdrPairs.push(['owl:imports', `<${suloNs}>`]);
    else if (!includeSulo && upperNs)   hdrPairs.push(['rdfs:seeAlso', `<${upperRaw}>`]);
    ttl.push(turtleBlock(`<${schema.url.replace(/\/$/, '')}>`, hdrPairs));
    ttl.push('');

    if (schema.classes.length > 0) {
      ttl.push('# ── Classes ──────────────────────────────────────────────────────────────');
      ttl.push('');
      for (const cls of schema.classes) {
        const pairs: [string, string][] = [['a', includeSulo ? 'owl:Class' : 'rdfs:Class']];
        if (cls.label)       pairs.push(['rdfs:label',   `"${escTtl(cls.label)}"`]);
        if (cls.description) pairs.push(['rdfs:comment', `"${escTtl(cls.description)}"`]);
        // Schema-level subClassOf (always emitted when present)
        if (cls.superClassId) {
          const superCls = schema.classes.find((c) => c.id === cls.superClassId);
          if (superCls) pairs.push(['rdfs:subClassOf', extIri(superCls)]);
        }
        if (includeSulo && cls.mapsToConceptIri) pairs.push(['rdfs:subClassOf', shortenIri(cls.mapsToConceptIri, pfxMap)]);
        ttl.push(turtleBlock(extIri(cls), pairs));
        ttl.push('');
      }
    }

    if (schema.properties.length > 0) {
      ttl.push('# ── Properties ───────────────────────────────────────────────────────────');
      ttl.push('');
      const domainClassDefs: string[] = [];

      // Group same-name same-domain properties to emit owl:unionOf for multi-range
      const owlPropGroups = new Map<string, typeof schema.properties>();
      for (const prop of schema.properties) {
        const key = `${prop.name}|${prop.domainClassId ?? ''}`;
        const g = owlPropGroups.get(key) ?? [];
        g.push(prop);
        owlPropGroups.set(key, g);
      }
      for (const group of owlPropGroups.values()) {
        const prop    = group[0];
        const domCls  = prop.domainClassId ? schema.classes.find((c) => c.id  === prop.domainClassId)  : null;
        const baseType = includeSulo
          ? (prop.propertyType === 'object' ? 'owl:ObjectProperty' : 'owl:DatatypeProperty')
          : 'rdfs:Property';
        const featureTypes = (prop.propertyFeatures ?? [])
          .map((f) => PROPERTY_FEATURE_OWL[f])
          .filter(Boolean);
        const propType = [baseType, ...featureTypes].join(', ');
        const pairs: [string, string][] = [['a', propType]];
        if (prop.label)              pairs.push(['rdfs:label',    `"${escTtl(prop.label)}"`]);
        if (prop.description)        pairs.push(['rdfs:comment',  `"${escTtl(prop.description)}"`]);
        // Inverse/disjoint references are stored as schema property names (→ :name)
        // or, for the disjoint free-text input, as external IRIs (→ shortened/<iri>).
        const propRef = (v: string) => (/:\/\//.test(v) ? shortenIri(v, pfxMap) : `:${v}`);
        if (prop.inversePropertyIri) pairs.push(['owl:inverseOf', propRef(prop.inversePropertyIri)]);
        for (const dIri of prop.disjointPropertyIris ?? []) {
          pairs.push(['owl:propertyDisjointWith', propRef(dIri)]);
        }

        // Domain
        if (includeSulo && prop.mappingPattern.length > 0 && domCls) {
          const domainRef = `<https://w3id.org/sulo/schema/resource/ontology-class/${crypto.randomUUID()}>`;
          pairs.push(['rdfs:domain', domainRef]);
          const expr = buildOwlExpr('?this', prop.mappingPattern, prop.rangeClassIri ?? domCls.url, pfxMap, classMap, domCls.url);
          domainClassDefs.push(`${domainRef}\n    owl:equivalentClass ${expr} .`);
        } else if (domCls) {
          pairs.push(['rdfs:domain', `:${domCls.name}`]);
        }

        // Range: union if multiple distinct ranges, otherwise single
        const rangeClasses = group
          .map((p) => p.rangeClassIri ? schema.classes.find((c) => c.url === p.rangeClassIri) : null)
          .filter((c): c is NonNullable<typeof c> => c != null);
        const uniqueRanges = [...new Map(rangeClasses.map((c) => [c.id, c])).values()];

        if (uniqueRanges.length > 1) {
          pairs.push(['rdfs:range', `[ owl:unionOf (${uniqueRanges.map((c) => extIri(c)).join(' ')}) ]`]);
        } else if (uniqueRanges.length === 1) {
          if (includeSulo && prop.mappingPattern.length > 0 && prop.rangeClassIri && domCls && prop.propertyType === 'object') {
            const rangeRef = `<https://w3id.org/sulo/schema/resource/ontology-class/${crypto.randomUUID()}>`;
            pairs.push(['rdfs:range', rangeRef]);
            const expr = buildReverseOwlExpr('?value', prop.mappingPattern, domCls.url, prop.rangeClassIri, pfxMap, classMap);
            domainClassDefs.push(`${rangeRef}\n    owl:equivalentClass ${expr} .`);
          } else {
            pairs.push(['rdfs:range', extIri(uniqueRanges[0])]);
          }
        } else if (prop.rangeClassIri) {
          pairs.push(['rdfs:range', shortenIri(prop.rangeClassIri, pfxMap)]);
        }

        ttl.push(turtleBlock(`:${prop.name}`, pairs));
        ttl.push('');
      }

      if (domainClassDefs.length > 0) {
        ttl.push('# ── Domain / Range class expressions (OWL equivalent axioms) ──────────────');
        ttl.push('');
        for (const def of domainClassDefs) { ttl.push(def); ttl.push(''); }
      }
    }

    return ttl.join('\n');
  }

  const turtlePlain = buildTurtle(plainPfxMap, false);
  const turtleOwl   = buildTurtle(owlPfxMap,   true);

  // ── SHACL shapes (schema-native, no SULO) ────────────────────────────────
  const shaclPfxMap: Record<string, string> = {
    '':   base,
    sh:   'http://www.w3.org/ns/shacl#',
    owl:  'http://www.w3.org/2002/07/owl#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    xsd:  'http://www.w3.org/2001/XMLSchema#',
  };

  const shacl: string[] = [];
  for (const [p, ns] of Object.entries(shaclPfxMap)) shacl.push(`@prefix ${p}: <${ns}> .`);
  shacl.push('');

  for (const cls of schema.classes) {
    const props = propsByClass.get(cls.id) ?? [];

    // Group same-name props into union range (same logic as OWL)
    const propGroups = new Map<string, typeof props>();
    for (const p of props) {
      const g = propGroups.get(p.name) ?? [];
      g.push(p);
      propGroups.set(p.name, g);
    }
    const propGroupEntries = Array.from(propGroups.entries());

    shacl.push(`:${cls.name}Shape`);
    shacl.push('    a sh:NodeShape, owl:Class ;');
    shacl.push(`    sh:targetClass ${extIri(cls)} ;`);
    if (cls.superClassId) {
      const superCls = schema.classes.find((c) => c.id === cls.superClassId);
      if (superCls) shacl.push(`    rdfs:subClassOf ${extIri(superCls)} ;`);
    }
    if (cls.label) shacl.push(`    rdfs:label "${escTtl(cls.label)}" ;`);

    propGroupEntries.forEach(([propName, group], i) => {
      const rep    = group[0];
      const isLast = i === propGroupEntries.length - 1;

      const propLines: string[] = [];
      propLines.push('    sh:property [');
      propLines.push(`        sh:path :${propName} ;`);
      if (rep.label) propLines.push(`        sh:name "${escTtl(rep.label)}" ;`);

      if (rep.propertyType === 'object') {
        const rangeClasses = group
          .map((p) => p.rangeClassIri ? schema.classes.find((c) => c.url === p.rangeClassIri) : null)
          .filter((c): c is NonNullable<typeof c> => c != null);
        const uniqueRanges = [...new Map(rangeClasses.map((c) => [c.id, c])).values()];
        if (uniqueRanges.length > 1) {
          propLines.push(`        sh:or (`);
          uniqueRanges.forEach((rc) => propLines.push(`            [ sh:class ${extIri(rc)} ]`));
          propLines.push(`        ) ;`);
        } else if (uniqueRanges.length === 1) {
          propLines.push(`        sh:class ${extIri(uniqueRanges[0])} ;`);
        } else if (rep.rangeClassIri) {
          propLines.push(`        sh:class ${shortenIri(rep.rangeClassIri, shaclPfxMap)} ;`);
        }
      } else if (rep.propertyType === 'datatype' && rep.rangeClassIri) {
        propLines.push(`        sh:datatype ${shortenIri(rep.rangeClassIri, { xsd: 'http://www.w3.org/2001/XMLSchema#' })} ;`);
      }

      propLines.push(`        sh:minCount ${rep.isRequired ? 1 : 0} ;`);
      propLines.push(`    ]${isLast ? ' .' : ' ;'}`);
      shacl.push(...propLines);
    });

    if (propGroupEntries.length === 0) {
      const last = shacl[shacl.length - 1];
      shacl[shacl.length - 1] = last.endsWith(' ;') ? last.slice(0, -2) + ' .' : last;
    }

    shacl.push('');
  }

  return { turtlePlain, turtleOwl, shaclTtl: shacl.join('\n') };
}

// ─── Mermaid generator ────────────────────────────────────────────────────────

export function buildMermaid(schema: OntologySchema): string {
  const SULO_PFX = 'https://w3id.org/sulo/';
  const lines: string[] = ['classDiagram'];

  for (const cls of schema.classes) {
    const props = schema.properties.filter((p) => p.domainClassId === cls.id);
    lines.push(`  class ${cls.name} {`);
    if (cls.mapsToConceptIri?.startsWith(SULO_PFX)) {
      lines.push(`    <<sulo:${cls.mapsToConceptIri.slice(SULO_PFX.length)}>>`);
    }
    for (const p of props) {
      const rangeCls = p.rangeClassIri ? schema.classes.find((c) => c.url === p.rangeClassIri) : null;
      const rangeLabel = rangeCls?.name
        ?? (p.rangeClassIri ? p.rangeClassIri.split(/[/#]/).pop()! : 'Any');
      lines.push(`    +${p.name}() ${rangeLabel}`);
    }
    lines.push('  }');
  }

  lines.push('');
  for (const cls of schema.classes) {
    if (!cls.superClassId) continue;
    const superCls = schema.classes.find((c) => c.id === cls.superClassId);
    if (superCls) lines.push(`  ${superCls.name} <|-- ${cls.name}`);
  }
  for (const prop of schema.properties) {
    if (!prop.domainClassId || !prop.rangeClassIri) continue;
    const domCls   = schema.classes.find((c) => c.id  === prop.domainClassId);
    const rangeCls = schema.classes.find((c) => c.url === prop.rangeClassIri);
    if (!domCls || !rangeCls) continue;
    const arrow = prop.propertyType === 'datatype' ? ' ..> ' : ' --> ';
    lines.push(`  ${domCls.name}${arrow}${rangeCls.name} : ${prop.name}`);
  }

  return lines.join('\n');
}
