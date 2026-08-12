// Generates real ShEx (Shape Expressions) shapes from a property's own
// mapping pattern — the same TripleTemplate[] the SPARQL CONSTRUCT compiler
// (sparqlConstruct.service.ts) already unfolds — and checks cross-schema
// "transformability" with a ShapeMap (shexSpec/shape-map) via the actual
// `shex-validate` tool, not this app's own ad hoc shape-key string comparison.
//
// A property's mapping pattern only ever takes one of two forms in this tool:
//   1 triple:  ?this P ?value                              (direct relation)
//   3 triples: ?this P1 ?o1 . ?o1 a T . ?o1 P2 ?value       (single-hop reification)
// Both translate directly into a ShEx shape; anything else is not supported.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import type { FullOntologyProperty, FullOntologySchema } from './schema.service.js';
import { classIriMap } from './sparqlConstruct.service.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

// Full datatype IRIs (not a prefixed xsd: form) so the generated sample data
// is a valid, self-contained Turtle file with no prefix declarations needed.
function sampleLiteral(rangeIri: string | undefined): string {
  const local = rangeIri?.startsWith(XSD) ? rangeIri.slice(XSD.length) : undefined;
  switch (local) {
    case 'integer': return `"42"^^<${XSD}integer>`;
    case 'float': return `"3.14"^^<${XSD}float>`;
    case 'decimal': return `"3.14"^^<${XSD}decimal>`;
    case 'double': return `"3.14"^^<${XSD}double>`;
    case 'boolean': return `"true"^^<${XSD}boolean>`;
    case 'dateTime': return `"2024-01-01T00:00:00"^^<${XSD}dateTime>`;
    case 'date': return `"2024-01-01"^^<${XSD}date>`;
    case 'time': return `"00:00:00"^^<${XSD}time>`;
    default: return '"sample"';
  }
}

function shexLeafConstraint(rangeIri: string | undefined, isObjectProp: boolean): string {
  if (isObjectProp) return 'IRI';
  const local = rangeIri?.startsWith(XSD) ? rangeIri.slice(XSD.length) : undefined;
  return local ? `xsd:${local}` : 'LITERAL';
}

export interface PropertyShex {
  /** ShExC shape declarations this property needs — one or two `<#Label> {...}` blocks. */
  shexDecls: string;
  /** Fragment label a ShapeMap should pair a subject IRI against. */
  rootLabel: string;
  /** Ground ShExC/Turtle triples satisfying this shape, for a given subject IRI. */
  sample(subjectIri: string): string;
}

/**
 * Compile one property's mapping pattern into a standalone ShEx shape plus a
 * matching synthetic instance — everything needed to validate it in isolation.
 * Returns null for mapping-pattern shapes this tool never actually produces
 * (empty, or longer than the single-hop-reification chain).
 */
export function buildPropertyShex(
  prop: FullOntologyProperty,
  schema: FullOntologySchema,
  uid: string,
): PropertyShex | null {
  const pattern = prop.mappingPattern;
  if (!pattern.length || pattern.length > 3) return null;
  const cm = classIriMap(schema);
  const rootLabel = `#${uid}_Root`;
  const leafConstraint = shexLeafConstraint(prop.rangeClassIri, prop.propertyType === 'object');
  const leafSample = prop.propertyType === 'object' ? `<urn:shex-sample:${uid}-value>` : sampleLiteral(prop.rangeClassIri);

  if (pattern.length === 1) {
    const [t] = pattern;
    return {
      shexDecls: `<${rootLabel}> {\n  <${t.predicate}> ${leafConstraint}\n}`,
      rootLabel,
      sample: (subjectIri) => `<${subjectIri}> <${t.predicate}> ${leafSample} .`,
    };
  }

  // 3-triple single-hop reification: ?this P1 ?o1 . ?o1 a T . ?o1 P2 ?value
  const [t1, t2, t3] = pattern;
  if (t2.predicate !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') return null;
  const nestedLabel = `#${uid}_Nested`;
  const typeIri = cm.get(t2.object) ?? t2.object;
  return {
    shexDecls: [
      `<${rootLabel}> {\n  <${t1.predicate}> @<${nestedLabel}>\n}`,
      `<${nestedLabel}> {\n  a [<${typeIri}>] ;\n  <${t3.predicate}> ${leafConstraint}\n}`,
    ].join('\n\n'),
    rootLabel,
    sample: (subjectIri) => {
      const oNode = `urn:shex-sample:${uid}-o1`;
      return [
        `<${subjectIri}> <${t1.predicate}> <${oNode}> .`,
        `<${oNode}> a <${typeIri}> .`,
        `<${oNode}> <${t3.predicate}> ${leafSample} .`,
      ].join('\n');
    },
  };
}

// ─── shex-validate invocation ───────────────────────────────────────────────

export class ShexUnavailableError extends Error {}

interface ShexVerdict {
  conformant: boolean;
  errors?: unknown;
}

function runShexValidate(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      config.shex.shexValidatePath,
      args,
      { timeout: config.shex.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new ShexUnavailableError('shex-validate executable not found on the server'));
          } else {
            reject(Object.assign(err, { stdout }));
          }
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function validateOne(shexPath: string, dataPath: string, shapeMap: string): Promise<ShexVerdict> {
  // shex-validate exits with a non-zero code for a genuine nonconformant
  // result, not only for a tool crash — but it still prints valid JSON to
  // stdout in that case, so a rejected promise with parseable stdout is a
  // real "Failure" verdict, not an error.
  let stdout: string;
  try {
    stdout = await runShexValidate(['-x', shexPath, '-d', dataPath, '-m', shapeMap]);
  } catch (err) {
    if (err instanceof ShexUnavailableError) throw err;
    const failedStdout = (err as NodeJS.ErrnoException & { stdout?: string }).stdout;
    if (!failedStdout) throw err;
    stdout = failedStdout;
  }
  const parsed = JSON.parse(stdout);
  return parsed.type === 'Failure' ? { conformant: false, errors: parsed.errors } : { conformant: true };
}

export interface ShexTransformabilityResult {
  sourceShex: string;
  targetShex: string;
  sourceRootLabel: string;
  targetRootLabel: string;
  sampleData: string;
  /** Does data shaped like the TARGET also conform to the SOURCE's shape? */
  sourceAcceptsTarget: ShexVerdict;
  /** Does data shaped like the SOURCE also conform to the TARGET's shape? */
  targetAcceptsSource: ShexVerdict;
  transformable: boolean;
}

/**
 * Checks whether two properties (typically a source/target pair a user has
 * confirmed or the shape-matcher suggested) are transformable into each
 * other's shape, using a real ShapeMap + shex-validate run in both
 * directions rather than this tool's own shape-key string comparison.
 */
export async function checkShexTransformability(
  sourceProp: FullOntologyProperty,
  sourceSchema: FullOntologySchema,
  targetProp: FullOntologyProperty,
  targetSchema: FullOntologySchema,
): Promise<ShexTransformabilityResult | null> {
  const src = buildPropertyShex(sourceProp, sourceSchema, 'source');
  const tgt = buildPropertyShex(targetProp, targetSchema, 'target');
  if (!src || !tgt) return null;

  const sourceSubject = 'urn:shex-sample:source-this';
  const targetSubject = 'urn:shex-sample:target-this';
  const allShex = `PREFIX xsd: <${XSD}>\n\n${[src.shexDecls, tgt.shexDecls].join('\n\n')}`;
  const allData = [src.sample(sourceSubject), tgt.sample(targetSubject)].join('\n');

  const dir = await mkdtemp(join(tmpdir(), 'sulo-shex-'));
  const shexPath = join(dir, 'schema.shex');
  const dataPath = join(dir, 'data.ttl');
  try {
    await writeFile(shexPath, allShex, 'utf8');
    await writeFile(dataPath, allData, 'utf8');

    const [sourceAcceptsTarget, targetAcceptsSource] = await Promise.all([
      validateOne(shexPath, dataPath, `<${targetSubject}>@<${src.rootLabel}>`),
      validateOne(shexPath, dataPath, `<${sourceSubject}>@<${tgt.rootLabel}>`),
    ]);

    return {
      sourceShex: src.shexDecls,
      targetShex: tgt.shexDecls,
      sourceRootLabel: src.rootLabel,
      targetRootLabel: tgt.rootLabel,
      sampleData: allData,
      sourceAcceptsTarget,
      targetAcceptsSource,
      transformable: sourceAcceptsTarget.conformant && targetAcceptsSource.conformant,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
