import React, { useState, useEffect, useRef, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  EdgeLabelRenderer,
  useNodesState,
  useEdgesState,
  type Node as RFNode,
  type Edge as RFEdge,
  type EdgeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  useOntologySchemas,
  useOntologySchema,
  useCreateOntologySchema,
  useUpdateOntologySchema,
  useDeleteOntologySchema,
  useAddOntologyClass,
  useUpdateOntologyClass,
  useDeleteOntologyClass,
  useAddOntologyProperty,
  useUpdateOntologyProperty,
  useDeleteOntologyProperty,
  useUpperConcepts,
  getReasonerStatus,
  reasonOntologyServer,
  setJavaPath,
  retryRobotDownload,
  type OntologyClass,
  type OntologyProperty,
  type OntologySchema,
  type UpperConcept,
  type TripleTemplate,
  type ConsistencyReport,
  type ReasonerStatus,
  type JavaStatus,
  type RobotStatus,
  type SuloStatus,
} from '../api/ontology.js';
import { useAuth } from '../auth/useAuth.js';
import {
  extractNamedGroups,
  generateExports,
  buildMermaid,
} from '@sulo/schema-core';
import {
  NewSchemaFormSchema,
  EditSchemaFormSchema,
  NewClassFormSchema,
  NewPropertyFormSchema,
  type NewSchemaForm,
  type EditSchemaForm,
  type NewClassForm,
  type NewPropertyForm,
} from '../lib/formSchemas.js';
import PropertyFeaturesEditor from '../components/PropertyFeaturesEditor.js';
import ShareDialog from '../components/ShareDialog.js';
import ConsistencyBadge from '../components/ConsistencyBadge.js';
import { useQueryClient } from '@tanstack/react-query';
import {
  serializeSchema,
  parseSchemaExport,
  importSchemaExport,
  buildShareUrl,
  decodeShareFragment,
  SHARE_FRAGMENT_PREFIX,
  type SchemaExport,
} from '../lib/schemaTransfer.js';

// ─── Scope tabs (mine / shared with me / public) ────────────────────────────
//
// Meaningful only against the Postgres (web) backend — the desktop/SQLite
// path has no `users` table and so no notion of scope at all (see the module
// comment in api/src/modules/schemas/routes.ts). An anonymous web visitor can
// only ever ask for `public` (`mine`/`shared` describe a relationship to a
// session-less caller and 401 server-side), so they get one, non-interactive
// tab rather than three where two would only ever 401.
const SCOPE_TABS: { value: 'mine' | 'shared' | 'public'; label: string }[] = [
  { value: 'mine', label: 'Mine' },
  { value: 'shared', label: 'Shared with me' },
  { value: 'public', label: 'Public' },
];

// ─── Common XSD types for range dropdown ─────────────────────────────────────

const XSD_TYPES = [
  { label: 'string', value: 'http://www.w3.org/2001/XMLSchema#string' },
  { label: 'integer', value: 'http://www.w3.org/2001/XMLSchema#integer' },
  { label: 'decimal', value: 'http://www.w3.org/2001/XMLSchema#decimal' },
  { label: 'boolean', value: 'http://www.w3.org/2001/XMLSchema#boolean' },
  { label: 'date', value: 'http://www.w3.org/2001/XMLSchema#date' },
  { label: 'dateTime', value: 'http://www.w3.org/2001/XMLSchema#dateTime' },
  { label: 'anyURI', value: 'http://www.w3.org/2001/XMLSchema#anyURI' },
  { label: 'float', value: 'http://www.w3.org/2001/XMLSchema#float' },
];

// ─── Zod schemas for forms (see ../lib/formSchemas) ──────────────────────────

// ─── Sub-components ───────────────────────────────────────────────────────────

function FieldRow({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...props }, ref) => (
    <input
      ref={ref}
      {...props}
      className={`w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 ${className}`}
    />
  ),
);

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = '', ...props }, ref) => (
    <textarea
      ref={ref}
      {...props}
      rows={2}
      className={`w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 resize-none ${className}`}
    />
  ),
);

// ─── Concept combobox ─────────────────────────────────────────────────────────

interface ConceptComboboxProps {
  value: string;
  onChange: (iri: string) => void;
  concepts: UpperConcept[];
  loading?: boolean;
  placeholder?: string;
}

function ConceptCombobox({ value, onChange, concepts, loading, placeholder }: ConceptComboboxProps) {
  const [query, setQuery] = useState(value);
  const [open, setOpen]   = useState(false);
  const containerRef      = useRef<HTMLDivElement>(null);

  // Keep query in sync when value is set externally (e.g. form reset)
  useEffect(() => { setQuery(value); }, [value]);

  // Close on outside click
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return concepts.slice(0, 50);
    return concepts.filter(
      (c) =>
        c.localName.toLowerCase().includes(q) ||
        (c.label ?? '').toLowerCase().includes(q) ||
        c.iri.toLowerCase().includes(q),
    ).slice(0, 50);
  }, [query, concepts]);

  function select(concept: UpperConcept) {
    onChange(concept.iri);
    setQuery(concept.iri);
    setOpen(false);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value);
    onChange(e.target.value);   // keep form value in sync for free-text IRIs
    setOpen(true);
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={handleInputChange}
          onFocus={() => setOpen(true)}
          placeholder={loading ? 'Loading concepts…' : (placeholder ?? 'Search or paste IRI…')}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm pr-8 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(''); onChange(''); setOpen(false); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs"
            tabIndex={-1}
          >
            ✕
          </button>
        )}
      </div>

      {open && filtered.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto text-sm">
          {filtered.map((c) => (
            <li key={c.iri}>
              <button
                type="button"
                onPointerDown={(e) => { e.preventDefault(); select(c); }}
                className="w-full text-left px-3 py-2.5 hover:bg-violet-50 transition-colors border-b border-slate-100 last:border-0"
              >
                <div className="font-medium text-slate-800">{c.label ?? c.localName}</div>
                {c.label && c.label !== c.localName && (
                  <div className="text-xs text-slate-400 font-mono">{c.localName}</div>
                )}
                {c.comment && (
                  <div className="text-xs text-slate-500 mt-0.5 line-clamp-1">{c.comment}</div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && !loading && concepts.length === 0 && query.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-3 text-xs text-slate-400">
          No concepts found. Using IRI as-is.
        </div>
      )}
    </div>
  );
}

// ─── Triple pattern editor ────────────────────────────────────────────────────

const SUBJECT_VARS = ['?this', '?o1', '?o2', '?o3', '?o4'];
const OBJECT_VARS  = ['?value', '?o1', '?o2', '?o3', '?o4'];
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
// Not a SULO property, so it never comes back from the upper-ontology concept
// fetch — but every reification pattern in this tool's own conventions needs
// an `?oN a <Role/Process/...>` triple, so it's pinned in as its own option
// rather than requiring the user to paste the raw IRI by hand.
const RDF_TYPE_CONCEPT: UpperConcept = {
  iri: RDF_TYPE,
  localName: 'type',
  type: 'property',
  label: 'a (rdf:type)',
  comment: 'Asserts the class of the subject — use to type an intermediate node (e.g. ?o1 a Role).',
};

interface TriplePatternEditorProps {
  value: TripleTemplate[];
  onChange: (v: TripleTemplate[]) => void;
  concepts: UpperConcept[];
  classes?: OntologyClass[];
  loading?: boolean;
}

function TriplePatternEditor({ value, onChange, concepts, classes, loading }: TriplePatternEditorProps) {
  const propConcepts = useMemo(
    () => [RDF_TYPE_CONCEPT, ...concepts.filter((c) => c.type === 'property')],
    [concepts],
  );
  const classConcepts = useMemo(
    () => concepts.filter((c) => c.type === 'class'),
    [concepts],
  );

  function addTriple() {
    onChange([...value, { subject: '?this', predicate: '', object: '?value' }]);
  }
  function removeTriple(i: number) { onChange(value.filter((_, idx) => idx !== i)); }
  function updateTriple(i: number, patch: Partial<TripleTemplate>) {
    const next = [...value];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="text-xs text-slate-400 italic">No mapping defined — add a triple below.</p>
      )}

      {value.length > 0 && (
        <div className="space-y-2">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_2fr_1fr_auto] gap-2 text-xs font-medium text-slate-400 px-1">
            <span>Subject</span>
            <span>Predicate</span>
            <span>Object</span>
            <span />
          </div>

          {value.map((triple, i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_1fr_auto] gap-2 items-center">
              {/* Subject */}
              <select
                value={triple.subject}
                onChange={(e) => updateTriple(i, { subject: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-mono text-violet-700 bg-violet-50 shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              >
                {SUBJECT_VARS.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>

              {/* Predicate */}
              <ConceptCombobox
                value={triple.predicate}
                onChange={(iri) => updateTriple(i, { predicate: iri })}
                concepts={propConcepts}
                loading={loading}
                placeholder="select predicate…"
              />

              {/* Object */}
              {(() => {
                const isVar      = OBJECT_VARS.includes(triple.object);
                const isCls      = classes?.some((c) => c.url === triple.object) ?? false;
                const isSuloCls  = classConcepts.some((c) => c.iri === triple.object);
                const isExternal = triple.object && !isVar && !isCls && !isSuloCls;
                return (
                  <select
                    value={triple.object}
                    onChange={(e) => updateTriple(i, { object: e.target.value })}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-mono text-emerald-700 bg-emerald-50 shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                  >
                    <optgroup label="Variables">
                      {OBJECT_VARS.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </optgroup>
                    {classes && classes.length > 0 && (
                      <optgroup label="Schema Classes">
                        {classes.map((cls) => (
                          <option key={cls.url} value={cls.url}>
                            {cls.label ?? cls.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {classConcepts.length > 0 && (
                      <optgroup label="SULO Classes">
                        {classConcepts.map((c) => (
                          <option key={c.iri} value={c.iri}>
                            {c.label ?? c.localName}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {isExternal && (
                      <optgroup label="External">
                        <option value={triple.object}>
                          :{triple.object.split(/[/#]/).pop()}
                        </option>
                      </optgroup>
                    )}
                  </select>
                );
              })()}

              <button
                type="button"
                onClick={() => removeTriple(i)}
                className="text-slate-300 hover:text-red-400 text-sm leading-none shrink-0"
                title="Remove triple"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* SPARQL-style preview */}
      {value.length > 0 && value.every((t) => t.predicate) && (
        <p className="text-xs font-mono text-slate-500 bg-slate-50 rounded px-2 py-1.5 break-all leading-relaxed">
          {value.map((t, i) => {
            const localPred = t.predicate === RDF_TYPE ? 'a' : (t.predicate.split(/[/#]/).pop() ?? t.predicate);
            const localObj  = t.object.startsWith('?')
              ? t.object
              : (classes?.find((c) => c.url === t.object)?.label
                  ?? classes?.find((c) => c.url === t.object)?.name
                  ?? classConcepts.find((c) => c.iri === t.object)?.label
                  ?? classConcepts.find((c) => c.iri === t.object)?.localName
                  ?? t.object.split(/[/#]/).pop()
                  ?? t.object);
            return (
              <span key={i}>
                {i > 0 && <span className="text-slate-300"> .<br /></span>}
                <span className="text-violet-600">{t.subject}</span>
                {' '}<span className="text-slate-700">{localPred}</span>
                {' '}<span className="text-emerald-600">{localObj}</span>
              </span>
            );
          })}
        </p>
      )}

      <button
        type="button"
        onClick={addTriple}
        className="text-xs text-violet-600 hover:text-violet-800 hover:underline transition-colors"
      >
        + Add triple
      </button>
    </div>
  );
}

// ─── Regex pattern input ─────────────────────────────────────────────────────

function RegexPatternInput({
  variable, onVariableChange,
  pattern, onPatternChange,
}: {
  variable: string; onVariableChange: (v: string) => void;
  pattern: string;  onPatternChange:  (v: string) => void;
}) {
  const groups = useMemo(() => extractNamedGroups(pattern), [pattern]);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Variable name</label>
          <Input
            value={variable}
            onChange={(e) => onVariableChange(e.target.value)}
            placeholder="e.g. fullName"
            className="font-mono text-xs"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Regex pattern</label>
          <Input
            value={pattern}
            onChange={(e) => onPatternChange(e.target.value)}
            placeholder="e.g. (?<family>[a-zA-Z]+), (?<given>[a-zA-Z]+)"
            className="font-mono text-xs"
          />
        </div>
      </div>
      {(variable || pattern) && (
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 space-y-1.5">
          <p className="text-xs font-mono text-slate-500 break-all">
            <span className="text-slate-400">%Map:&#123; </span>
            {variable && <span className="text-emerald-600">?{variable}</span>}
            {variable && pattern && <span className="text-slate-400"> . </span>}
            {pattern && <span className="text-violet-700">regex(/{pattern}/)</span>}
            <span className="text-slate-400"> &#125;</span>
          </p>
          {pattern && groups.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-slate-400">Extracted variables:</span>
              {groups.map((g) => (
                <span key={g} className="text-xs font-mono bg-violet-50 text-violet-700 border border-violet-100 rounded px-1.5 py-0.5">
                  ?{g}
                </span>
              ))}
            </div>
          )}
          {pattern && groups.length === 0 && (
            <p className="text-xs text-amber-600">No named capture groups found. Use <span className="font-mono">(?&lt;name&gt;...)</span> syntax.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── UML ReactFlow diagram ────────────────────────────────────────────────────

interface UmlNodeData {
  name: string;
  stereotype: string;
  props: Array<{ name: string; range: string; isDatatype: boolean }>;
  isIntermediate: boolean;
}

function UmlClassNode({ data }: { data: UmlNodeData }) {
  const headerBg    = data.isIntermediate ? 'bg-amber-500'   : 'bg-violet-600';
  const borderColor = data.isIntermediate ? 'border-amber-400' : 'border-violet-400';
  const handleColor = data.isIntermediate ? '#f59e0b'          : '#7c3aed';
  const stereoBg    = data.isIntermediate ? 'bg-amber-50 text-amber-700 border-amber-200'
                                          : 'bg-violet-100 text-violet-600 border-violet-200';
  return (
    <div className={`rounded-lg border-2 ${borderColor} shadow-md bg-white min-w-[160px] max-w-[220px] text-left`}>
      <Handle type="source" id="s-left"   position={Position.Left}   style={{ background: handleColor, width: 6, height: 6 }} />
      <Handle type="source" id="s-right"  position={Position.Right}  style={{ background: handleColor, width: 6, height: 6 }} />
      <Handle type="source" id="s-top"    position={Position.Top}    style={{ background: handleColor, width: 6, height: 6 }} />
      <Handle type="source" id="s-bottom" position={Position.Bottom} style={{ background: handleColor, width: 6, height: 6 }} />
      <Handle type="target" id="t-left"   position={Position.Left}   style={{ background: handleColor, width: 6, height: 6 }} />
      <Handle type="target" id="t-right"  position={Position.Right}  style={{ background: handleColor, width: 6, height: 6 }} />
      <Handle type="target" id="t-top"    position={Position.Top}    style={{ background: handleColor, width: 6, height: 6 }} />
      <Handle type="target" id="t-bottom" position={Position.Bottom} style={{ background: handleColor, width: 6, height: 6 }} />
      <div className={`${headerBg} text-white text-xs font-bold px-3 py-1.5 rounded-t-md text-center`}>
        {data.name}
      </div>
      {data.stereotype && (
        <div className={`${stereoBg} text-[10px] px-2 py-0.5 text-center italic border-b`}>
          «{data.stereotype}»
        </div>
      )}
      {data.props.length > 0 && (
        <div className="divide-y divide-slate-100">
          {data.props.map((p) => (
            <div key={p.name} className="flex items-center gap-1 px-2 py-0.5 text-[10px]">
              <span className={p.isDatatype ? 'text-amber-500' : 'text-violet-400'}>
                {p.isDatatype ? '▸' : '+'}
              </span>
              <span className="text-slate-700 font-medium truncate">{p.name}</span>
              <span className="text-slate-400 ml-auto shrink-0">{p.range}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Custom edge: UML generalization (hollow triangle arrowhead — drawn as inline SVG geometry)
function InheritanceEdge({ sourceX, sourceY, targetX, targetY }: EdgeProps) {
  const angle = Math.atan2(targetY - sourceY, targetX - sourceX);
  const triSize = 14;
  // Base of triangle (where the line ends, just before the triangle tip)
  const baseX = targetX - triSize * Math.cos(angle);
  const baseY = targetY - triSize * Math.sin(angle);
  // Left and right corners of the triangle base
  const leftX = baseX + (triSize / 2) * Math.sin(angle);
  const leftY = baseY - (triSize / 2) * Math.cos(angle);
  const rightX = baseX - (triSize / 2) * Math.sin(angle);
  const rightY = baseY + (triSize / 2) * Math.cos(angle);

  return (
    <>
      {/* Line from source to base of triangle */}
      <path
        d={`M ${sourceX} ${sourceY} L ${baseX} ${baseY}`}
        style={{ stroke: '#64748b', strokeWidth: 2, fill: 'none' }}
      />
      {/* Hollow triangle pointing at target */}
      <polygon
        points={`${targetX},${targetY} ${leftX},${leftY} ${rightX},${rightY}`}
        style={{ fill: 'white', stroke: '#64748b', strokeWidth: 1.5 }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${(sourceY + targetY) / 2}px)`,
            fontSize: 9,
            color: '#94a3b8',
            fontStyle: 'italic',
            pointerEvents: 'none',
            background: 'rgba(15,23,42,0.7)',
            padding: '1px 4px',
            borderRadius: 3,
          }}
        >
          subClassOf
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const umlNodeTypes = { umlClass: UmlClassNode };
const umlEdgeTypes = { inheritance: InheritanceEdge };

/** Choose the closest source/target handle pair based on relative node positions. */
function pickHandles(
  positions: Map<string, { x: number; y: number }>,
  sourceId: string,
  targetId: string,
): { sourceHandle: string; targetHandle: string } {
  const s = positions.get(sourceId);
  const t = positions.get(targetId);
  if (!s || !t) return { sourceHandle: 's-right', targetHandle: 't-left' };
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 's-right', targetHandle: 't-left'  }
      : { sourceHandle: 's-left',  targetHandle: 't-right' };
  }
  return dy >= 0
    ? { sourceHandle: 's-bottom', targetHandle: 't-top'    }
    : { sourceHandle: 's-top',    targetHandle: 't-bottom' };
}

function buildUmlGraph(schema: OntologySchema): { nodes: RFNode[]; edges: RFEdge[] } {
  const SULO_PFX = 'https://w3id.org/sulo/';
  const COLS = 5;
  const COL_W = 260;
  const ROW_H = 220;

  // Classes that appear as fixed-IRI objects in any mapping pattern are "intermediate"
  // — they exist only to bridge the SULO mapping and don't appear in plain RDF Schema.
  const intermediateUrls = new Set<string>();
  for (const prop of schema.properties) {
    for (const triple of prop.mappingPattern) {
      if (!triple.object.startsWith('?')) {
        intermediateUrls.add(triple.object);
      }
    }
  }

  const nodes: RFNode[] = schema.classes.map((cls, i) => {
    const props = schema.properties.filter((p) => p.domainClassId === cls.id);
    const stereotype = cls.mapsToConceptIri?.startsWith(SULO_PFX)
      ? `sulo:${cls.mapsToConceptIri.slice(SULO_PFX.length)}`
      : '';
    const isIntermediate = intermediateUrls.has(cls.url);
    return {
      id: cls.id,
      type: 'umlClass',
      position: { x: (i % COLS) * COL_W, y: Math.floor(i / COLS) * ROW_H },
      data: {
        name: cls.name,
        stereotype,
        props: (() => {
          const seen = new Map<string, { ranges: string[]; isDatatype: boolean }>();
          for (const p of props) {
            const rangeCls = p.rangeClassIri ? schema.classes.find((c) => c.url === p.rangeClassIri) : null;
            const range = rangeCls?.name ?? (p.rangeClassIri ? p.rangeClassIri.split(/[/#]/).pop()! : '');
            const entry = seen.get(p.name);
            if (entry) { if (range && !entry.ranges.includes(range)) entry.ranges.push(range); }
            else seen.set(p.name, { ranges: range ? [range] : [], isDatatype: p.propertyType === 'datatype' });
          }
          return Array.from(seen.entries()).map(([name, { ranges, isDatatype }]) => ({
            name, range: ranges.join(' | '), isDatatype,
          }));
        })(),
        isIntermediate,
      } satisfies UmlNodeData,
    };
  });

  const nodePositions = new Map(nodes.map((n) => [n.id, n.position]));

  const inheritanceEdges: RFEdge[] = schema.classes
    .filter((c) => c.superClassId)
    .map((c) => {
      const { sourceHandle, targetHandle } = pickHandles(nodePositions, c.id, c.superClassId!);
      return {
        id: `${c.id}-subclassof`,
        type: 'inheritance',
        source: c.id,
        target: c.superClassId!,
        sourceHandle,
        targetHandle,
        animated: false,
      };
    });

  const propertyEdges: RFEdge[] = schema.properties
    .filter((p) => p.domainClassId && p.rangeClassIri)
    .map((p) => {
      const rangeCls = schema.classes.find((c) => c.url === p.rangeClassIri);
      if (!rangeCls) return null;
      const color = p.propertyType === 'datatype' ? '#f59e0b' : '#7c3aed';
      const { sourceHandle, targetHandle } = pickHandles(nodePositions, p.domainClassId!, rangeCls.id);
      return {
        id: `${p.id}-edge`,
        source: p.domainClassId!,
        target: rangeCls.id,
        sourceHandle,
        targetHandle,
        label: p.name,
        style: { stroke: color },
        markerEnd: { type: MarkerType.ArrowClosed, color },
        labelStyle: { fontSize: 9, fill: '#475569' },
        labelBgStyle: { fill: '#f8fafc', fillOpacity: 0.8 },
        animated: false,
      } satisfies RFEdge;
    })
    .filter(Boolean) as RFEdge[];

  return { nodes, edges: [...inheritanceEdges, ...propertyEdges] };
}

function UmlDiagramView({ schema, onClose }: { schema: OntologySchema; onClose: () => void }) {
  const initial = useMemo(() => buildUmlGraph(schema), [schema]);
  const [nodes, , onNodesChange] = useNodesState(initial.nodes);
  const [edges, , onEdgesChange] = useEdgesState(initial.edges);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900 flex flex-col">
      <div className="flex items-center justify-between px-5 py-3 bg-slate-800 shrink-0">
        <div>
          <h2 className="text-white font-semibold text-sm">{schema.title} — UML Class Diagram</h2>
          <p className="text-slate-400 text-xs mt-0.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-violet-600 mr-1 align-middle"></span> domain class &nbsp;
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-500 mr-1 align-middle"></span> intermediate (SULO only) &nbsp;·&nbsp;
            <span className="text-violet-400">+</span> object &nbsp;
            <span className="text-amber-400">▸</span> datatype &nbsp;
            <span className="text-slate-400">△</span> subClassOf &nbsp;·&nbsp;
            drag to rearrange
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white text-2xl leading-none transition-colors"
        >
          ×
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={umlNodeTypes}
          edgeTypes={umlEdgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
        >
          <Background color="#334155" gap={20} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

// ─── Export modal ─────────────────────────────────────────────────────────────

function ExportModal({ schema, onClose }: { schema: OntologySchema; onClose: () => void }) {
  const [tab, setTab]       = useState<'plain' | 'owl' | 'shacl' | 'uml'>('plain');
  const [copied, setCopied] = useState(false);
  const [showDiagram, setShowDiagram] = useState(false);
  const exports = useMemo(() => generateExports(schema), [schema]);
  const mermaid  = useMemo(() => buildMermaid(schema), [schema]);

  const slug = schema.title.replace(/\s+/g, '_');
  const content =
    tab === 'plain'  ? exports.turtlePlain :
    tab === 'owl'    ? exports.turtleOwl   :
    tab === 'shacl'  ? exports.shaclTtl    : mermaid;
  const filename =
    tab === 'plain'  ? `${slug}.ttl`          :
    tab === 'owl'    ? `${slug}_sulo.owl.ttl` :
    tab === 'shacl'  ? `${slug}_shacl.ttl`   : `${slug}_uml.mmd`;

  function copy() {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function download() {
    const blob = new Blob([content], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
          <div>
            <h2 className="font-semibold text-slate-800 text-lg">Generate export</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Download or copy these files to use with a SULO-compliant processor.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-2xl leading-none ml-4">×</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-3 border-b border-slate-200 shrink-0">
          {([
            { key: 'plain',  label: 'RDF Schema' },
            { key: 'owl',    label: 'OWL + SULO' },
            { key: 'shacl',  label: 'SHACL' },
            { key: 'uml',    label: 'UML Diagram' },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                tab === key
                  ? 'bg-white border border-b-white border-slate-200 text-violet-700 -mb-px'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Code area */}
        <div className="flex-1 overflow-auto min-h-0 p-4">
          {tab === 'uml' && (
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs text-slate-500">Mermaid classDiagram — paste into <a href="https://mermaid.live" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">mermaid.live</a> or GitHub markdown</span>
              <button
                onClick={() => setShowDiagram(true)}
                className="text-xs bg-violet-600 hover:bg-violet-500 text-white px-3 py-1 rounded-lg transition-colors"
              >
                View Interactive Diagram ↗
              </button>
            </div>
          )}
          <pre className="text-xs font-mono text-slate-700 whitespace-pre bg-slate-50 rounded-lg p-4 leading-relaxed min-h-[200px] overflow-x-auto">
            {content}
          </pre>
        </div>
        {showDiagram && (
          <UmlDiagramView schema={schema} onClose={() => setShowDiagram(false)} />
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-200 shrink-0">
          <span className="text-xs text-slate-400 font-mono">{filename}</span>
          <div className="flex gap-3">
            <button
              onClick={copy}
              className="text-sm text-slate-600 hover:text-slate-800 border border-slate-200 hover:border-slate-300 px-4 py-2 rounded-lg transition-colors"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button
              onClick={download}
              className="bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
            >
              Download
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Consistency panel ─────────────────────────────────────────────────────────

const JAVA_DOWNLOAD_URL = 'https://adoptium.net/temurin/releases/?version=21';

function formatMb(bytes?: number): string {
  return bytes === undefined ? '?' : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Prompt for a JVM when the packaged app can't find one.
 *
 * A plain path field rather than a native file picker: the desktop shell points
 * its webview at the local API's URL, so the page is ordinary remote content and
 * never receives the Tauri API — a file dialog isn't reachable from here.
 */
function JavaSetup({ java, onResolved }: { java: JavaStatus; onResolved: (s: ReasonerStatus) => void }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    setError('');
    try {
      onResolved(await setJavaPath(path.trim()));
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setError(e2.response?.data?.message ?? 'That path could not be used as a Java runtime.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-xs text-amber-900 space-y-3">
      <div>
        <p className="font-medium">
          {java.reason === 'too_old'
            ? `Java ${java.version ?? ''} found, but the reasoner needs 11 or newer.`
            : 'The consistency check needs Java, and none was found.'}
        </p>
        <p className="mt-1 text-amber-800">
          Install Java 11+ —{' '}
          <a href={JAVA_DOWNLOAD_URL} target="_blank" rel="noreferrer" className="underline font-medium">
            download Temurin
          </a>
          {' '}— then reopen this panel. Everything else in the app works without it.
        </p>
        {java.detail && <p className="mt-1 font-mono text-[11px] text-amber-700 break-all">{java.detail}</p>}
      </div>

      <form onSubmit={submit} className="space-y-1.5">
        <label className="block font-medium">
          Already have Java? Point us at it.
        </label>
        <p className="text-amber-800">
          Apps launched from the Finder or Start Menu don&apos;t see your shell&apos;s PATH, so a Java
          installed via Homebrew, SDKMAN or asdf may need naming explicitly.
        </p>
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/opt/homebrew/opt/openjdk@21/bin/java"
            className="flex-1 border border-amber-300 rounded-lg px-2 py-1 font-mono text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
          <button
            type="submit"
            disabled={busy || !path.trim()}
            className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white px-3 py-1 rounded-lg transition-colors shrink-0"
          >
            {busy ? 'Checking…' : 'Use this'}
          </button>
        </div>
        {error && <p className="text-rose-700 font-medium">{error}</p>}
      </form>
    </div>
  );
}

function RobotSetup({ robot, onRetried }: { robot: RobotStatus; onRetried: (s: ReasonerStatus) => void }) {
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      onRetried(await retryRobotDownload());
    } finally {
      setBusy(false);
    }
  }

  if (robot.state === 'error') {
    return (
      <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-xs text-amber-900 space-y-2">
        <p className="font-medium">The reasoner (ROBOT {robot.version}) couldn&apos;t be downloaded.</p>
        {robot.error && <p className="font-mono text-[11px] text-amber-700 break-all">{robot.error}</p>}
        <p>
          If this machine is offline, you can place <span className="font-mono">robot.jar</span> in the
          app&apos;s data folder by hand and retry.
        </p>
        <button
          onClick={retry}
          disabled={busy}
          className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white px-3 py-1 rounded-lg transition-colors"
        >
          {busy ? 'Retrying…' : 'Retry download'}
        </button>
      </div>
    );
  }

  const pct = robot.total ? Math.round(((robot.received ?? 0) / robot.total) * 100) : null;
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 text-xs text-slate-600 space-y-2">
      <p className="font-medium text-slate-700">Downloading the reasoner (ROBOT {robot.version})…</p>
      <p>
        This happens once, on first launch — it isn&apos;t bundled with the app because it&apos;s large.
      </p>
      <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-indigo-500 transition-all duration-500"
          style={{ width: pct === null ? '35%' : `${pct}%` }}
        />
      </div>
      <p className="font-mono text-[11px] text-slate-500">
        {formatMb(robot.received)}{robot.total ? ` / ${formatMb(robot.total)}` : ''}
      </p>
    </div>
  );
}

function SuloFootnote({ sulo }: { sulo: SuloStatus }) {
  return (
    <p className="text-[11px] text-slate-400 mt-3 pt-2 border-t border-slate-100">
      Reasoned against SULO {sulo.version ?? 'of unknown version'}
      {sulo.source === 'downloaded' ? ' (latest published)' : sulo.source === 'override' ? ' (local override)' : ' (bundled)'}
      {sulo.updateError ? ' — could not check for a newer release.' : '.'}
    </p>
  );
}

function ConsistencyPanel({ turtleOwl }: { turtleOwl: string }) {
  // Server-side full OWL DL (HermiT) consistency check.
  const [status, setStatus]               = useState<ReasonerStatus | null>(null);
  const [statusFailed, setStatusFailed]   = useState(false);
  const [serverReport, setServerReport]   = useState<ConsistencyReport | null>(null);
  const [serverState, setServerState]     = useState<'idle' | 'loading' | 'error'>('idle');
  const [serverError, setServerError]     = useState<string>('');

  // Probe what the backend can actually do: whether a JVM was found, whether
  // ROBOT has finished downloading, and which SULO is in use.
  useEffect(() => {
    let alive = true;
    getReasonerStatus()
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => { if (alive) setStatusFailed(true); });
    return () => { alive = false; };
  }, []);

  // While the first-launch download is in flight, keep the progress readout
  // moving. Polling stops as soon as the state is terminal.
  const downloading = status?.robot.state === 'downloading';
  useEffect(() => {
    if (!downloading) return;
    let alive = true;
    const id = setInterval(() => {
      getReasonerStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    }, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [downloading]);

  // Any change to the generated OWL invalidates a stale result.
  useEffect(() => { setServerReport(null); setServerState('idle'); setServerError(''); }, [turtleOwl]);

  async function runServer() {
    setServerState('loading');
    setServerError('');
    try {
      setServerReport(await reasonOntologyServer(turtleOwl));
      setServerState('idle');
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { message?: string } } };
      setServerState('error');
      setServerError(
        e.response?.data?.message
          ?? (e.response?.status === 503
            ? 'Server-side reasoning is not available in this deployment.'
            : 'The reasoner could not process this ontology.'),
      );
    }
  }

  const notAvailable = (message: string) => (
    <div className="min-h-[200px] flex items-center justify-center">
      <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-xs text-amber-800 max-w-md text-center">
        {message}
      </div>
    </div>
  );

  if (statusFailed) return notAvailable('Server-side OWL DL reasoning is not available in this deployment.');
  if (!status) return <div className="min-h-[200px] flex items-center justify-center text-sm text-slate-400">Checking…</div>;
  if (!status.enabled) return notAvailable('Server-side OWL DL reasoning is disabled in this deployment.');

  // Only the packaged desktop app manages its own toolchain; elsewhere Java and
  // ROBOT come from the image or the host and there is nothing to set up.
  if (status.managed && !status.java.available) {
    return (
      <div className="min-h-[200px]">
        <JavaSetup java={status.java} onResolved={setStatus} />
        <SuloFootnote sulo={status.sulo} />
      </div>
    );
  }
  if (status.managed && status.robot.state !== 'ready') {
    return (
      <div className="min-h-[200px]">
        <RobotSetup robot={status.robot} onRetried={setStatus} />
        <SuloFootnote sulo={status.sulo} />
      </div>
    );
  }

  return (
    <div className="min-h-[200px]">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-slate-500">
          <strong className="text-slate-600">Full OWL DL check (HermiT).</strong> Tableau reasoning over the
          complete SULO ontology — catches unsatisfiable classes and logical inconsistencies, including
          restriction, negation and disjoint-union errors that schema validators and SHACL miss.
        </span>
        <button
          onClick={runServer}
          disabled={serverState === 'loading'}
          className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-3 py-1 rounded-lg transition-colors shrink-0 ml-3"
        >
          {serverState === 'loading' ? 'Reasoning…' : serverReport ? 'Re-run' : 'Check consistency'}
        </button>
      </div>

      {serverState === 'error' ? (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
          {serverError}
        </div>
      ) : serverReport === null ? (
        <div className="flex items-center justify-center h-40 text-sm text-slate-400">
          {serverState === 'loading' ? 'Running HermiT…' : 'Click “Check consistency” to run the reasoner.'}
        </div>
      ) : serverReport.consistent ? (
        <div className="flex items-start gap-3 rounded-lg bg-emerald-50 border border-emerald-200 p-4">
          <span className="text-emerald-600 text-xl leading-none">✓</span>
          <div>
            <p className="text-sm font-medium text-emerald-800">Consistent</p>
            <p className="text-xs text-emerald-700 mt-0.5">
              {serverReport.reasoner} found no unsatisfiable classes and no logical inconsistency.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-rose-700">
            <span className="text-rose-600 text-xl leading-none">✕</span>
            {serverReport.clashes.length} {serverReport.clashes.length === 1 ? 'problem' : 'problems'} found by {serverReport.reasoner}
          </div>
          {serverReport.clashes.map((clash, i) => (
            <div key={i} className="rounded-lg bg-rose-50 border border-rose-200 p-3">
              <p className="text-xs font-mono font-medium text-rose-800">
                {clash.label ?? clash.iri ?? (clash.kind === 'inconsistent-ontology' ? 'Inconsistent ontology' : 'Unsatisfiable class')}
              </p>
              <pre className="text-xs text-rose-700 mt-1 leading-relaxed whitespace-pre-wrap font-sans">{clash.explanation}</pre>
            </div>
          ))}
        </div>
      )}

      <SuloFootnote sulo={status.sulo} />
    </div>
  );
}

// ─── Consistency modal ─────────────────────────────────────────────────────────

function ConsistencyModal({ schema, onClose }: { schema: OntologySchema; onClose: () => void }) {
  const turtleOwl = useMemo(() => generateExports(schema).turtleOwl, [schema]);
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
          <div>
            <h2 className="font-semibold text-slate-800 text-lg">Consistency check</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Full OWL DL reasoning (HermiT) over the generated OWL merged with SULO.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-2xl leading-none ml-4">×</button>
        </div>
        <div className="flex-1 overflow-auto min-h-0 p-5">
          <ConsistencyPanel turtleOwl={turtleOwl} />
        </div>
      </div>
    </div>
  );
}

// ─── Edit class form ─────────────────────────────────────────────────────────

function EditClassForm({
  cls, schemaId, allClasses, concepts, conceptsLoading, hasUpperOntology, onDone,
}: {
  cls: OntologyClass;
  schemaId: string;
  allClasses: OntologyClass[];
  concepts: UpperConcept[];
  conceptsLoading: boolean;
  hasUpperOntology: boolean;
  onDone: () => void;
}) {
  const updateClass = useUpdateOntologyClass(schemaId);
  const form = useForm<NewClassForm>({
    resolver: zodResolver(NewClassFormSchema),
    defaultValues: {
      name: cls.name,
      label: cls.label ?? '',
      description: cls.description ?? '',
      mapsToConceptIri: cls.mapsToConceptIri ?? '',
      superClassId: cls.superClassId ?? '',
    },
  });

  async function onSubmit(values: NewClassForm) {
    await updateClass.mutateAsync({
      classId: cls.id,
      data: {
        name: values.name,
        label: values.label || '',
        description: values.description || '',
        mapsToConceptIri: (values.mapsToConceptIri as string) || '',
        superClassId: values.superClassId || '',
      },
    });
    onDone();
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-3 border-t border-slate-100 mt-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldRow label="Name *" error={form.formState.errors.name?.message}>
          <Input {...form.register('name')} autoFocus />
        </FieldRow>
        <FieldRow label="Label" error={form.formState.errors.label?.message}>
          <Input {...form.register('label')} />
        </FieldRow>
      </div>
      <FieldRow label="Description" error={form.formState.errors.description?.message}>
        <Textarea {...form.register('description')} />
      </FieldRow>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldRow label="Maps to concept IRI" error={form.formState.errors.mapsToConceptIri?.message}>
          <Controller
            control={form.control}
            name="mapsToConceptIri"
            render={({ field }) => (
              <ConceptCombobox
                value={field.value ?? ''}
                onChange={field.onChange}
                concepts={concepts.filter((c) => c.type === 'class')}
                loading={conceptsLoading}
                placeholder={hasUpperOntology ? 'Search upper-ontology classes…' : 'e.g. https://w3id.org/sulo/Person'}
              />
            )}
          />
        </FieldRow>
        <FieldRow label="Subclass of" error={form.formState.errors.superClassId?.message}>
          <select
            {...form.register('superClassId')}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 bg-white"
          >
            <option value="">— none —</option>
            {allClasses.filter((c) => c.id !== cls.id).map((c) => (
              <option key={c.id} value={c.id}>{c.label ?? c.name}</option>
            ))}
          </select>
        </FieldRow>
      </div>
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={updateClass.isPending}
          className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
        >
          {updateClass.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-sm text-slate-500 hover:text-slate-700 px-5 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Edit property form ───────────────────────────────────────────────────────

function EditPropertyForm({
  prop, schemaId, classes, properties, concepts, conceptsLoading, onDone,
}: {
  prop: OntologyProperty;
  schemaId: string;
  classes: OntologyClass[];
  properties: OntologyProperty[];
  concepts: UpperConcept[];
  conceptsLoading: boolean;
  onDone: () => void;
}) {
  const updateProperty = useUpdateOntologyProperty(schemaId);
  const form = useForm<NewPropertyForm>({
    resolver: zodResolver(NewPropertyFormSchema),
    defaultValues: {
      name: prop.name,
      label: prop.label ?? '',
      description: prop.description ?? '',
      propertyType: prop.propertyType,
      domainClassId: prop.domainClassId ?? '',
      rangeClassIri: prop.rangeClassIri ?? '',
      mappingPattern: prop.mappingPattern,
      regexPattern: prop.regexPattern ?? '',
      regexVariable: prop.regexVariable ?? '',
      isRequired: prop.isRequired,
      propertyFeatures: prop.propertyFeatures ?? [],
      inversePropertyIri: prop.inversePropertyIri ?? '',
      disjointPropertyIris: prop.disjointPropertyIris ?? [],
    },
  });
  const watchPropertyType = form.watch('propertyType');

  async function onSubmit(values: NewPropertyForm) {
    await updateProperty.mutateAsync({
      propId: prop.id,
      data: {
        name: values.name,
        label: values.label || '',
        description: values.description || '',
        propertyType: values.propertyType,
        domainClassId: values.domainClassId || '',
        rangeClassIri: values.rangeClassIri || '',
        mappingPattern: (values.mappingPattern ?? []).filter((t) => t.predicate),
        regexPattern: values.regexPattern || '',
        regexVariable: values.regexVariable || '',
        isRequired: values.isRequired,
        propertyFeatures: (values.propertyFeatures ?? []) as import('../api/ontology').PropertyFeature[],
        inversePropertyIri: values.inversePropertyIri || '',
        disjointPropertyIris: values.disjointPropertyIris ?? [],
      },
    });
    onDone();
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-3 border-t border-slate-100 mt-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldRow label="Name *" error={form.formState.errors.name?.message}>
          <Input {...form.register('name')} autoFocus />
        </FieldRow>
        <FieldRow label="Label" error={form.formState.errors.label?.message}>
          <Input {...form.register('label')} />
        </FieldRow>
      </div>
      <FieldRow label="Description" error={form.formState.errors.description?.message}>
        <Textarea {...form.register('description')} />
      </FieldRow>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldRow label="Property type" error={form.formState.errors.propertyType?.message}>
          <select
            {...form.register('propertyType')}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
          >
            <option value="datatype">Datatype property (literal value)</option>
            <option value="object">Object property (links to a class)</option>
          </select>
        </FieldRow>
        <FieldRow label="Domain class" error={form.formState.errors.domainClassId?.message}>
          <select
            {...form.register('domainClassId')}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
          >
            <option value="">— any class —</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FieldRow>
      </div>
      <FieldRow label="Range" error={form.formState.errors.rangeClassIri?.message}>
        {watchPropertyType === 'datatype' ? (
          <select
            {...form.register('rangeClassIri')}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
          >
            <option value="">— select XSD type —</option>
            {XSD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        ) : (
          <select
            {...form.register('rangeClassIri')}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
          >
            <option value="">— select target class —</option>
            {classes.map((c) => <option key={c.id} value={c.url}>{c.name}</option>)}
          </select>
        )}
      </FieldRow>
      <FieldRow label="Mapping pattern" error={undefined}>
        <Controller
          control={form.control}
          name="mappingPattern"
          render={({ field }) => (
            <TriplePatternEditor
              value={field.value ?? []}
              onChange={field.onChange}
              concepts={concepts}
              classes={classes}
              loading={conceptsLoading}
            />
          )}
        />
      </FieldRow>
      <FieldRow label="Regex extraction (optional)" error={undefined}>
        <p className="text-xs text-slate-400 mb-1">
          Extract multiple variables from a single value using named capture groups.
          Example: <span className="font-mono">{'(?<family>[a-zA-Z]+), (?<given>[a-zA-Z]+)'}</span>
        </p>
        <Controller
          control={form.control}
          name="regexVariable"
          render={({ field: varField }) => (
            <Controller
              control={form.control}
              name="regexPattern"
              render={({ field: patField }) => (
                <RegexPatternInput
                  variable={varField.value ?? ''}
                  onVariableChange={varField.onChange}
                  pattern={patField.value ?? ''}
                  onPatternChange={patField.onChange}
                />
              )}
            />
          )}
        />
      </FieldRow>
      <FieldRow label="Property characteristics" error={undefined}>
        <Controller
          control={form.control}
          name="propertyFeatures"
          render={({ field: featField }) => (
            <Controller
              control={form.control}
              name="inversePropertyIri"
              render={({ field: invField }) => (
                <Controller
                  control={form.control}
                  name="disjointPropertyIris"
                  render={({ field: disjField }) => (
                    <PropertyFeaturesEditor
                      propertyType={watchPropertyType}
                      features={featField.value ?? []}
                      onChange={featField.onChange}
                      inverseIri={invField.value ?? ''}
                      onInverseIriChange={invField.onChange}
                      disjointPropertyIris={disjField.value ?? []}
                      onDisjointChange={disjField.onChange}
                      availableProperties={properties
                        .filter((p) => p.name !== prop.name)
                        .map((p) => ({ name: p.name, url: p.url }))}
                    />
                  )}
                />
              )}
            />
          )}
        />
      </FieldRow>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`edit-isRequired-${prop.id}`}
          {...form.register('isRequired')}
          className="w-4 h-4 text-violet-600 rounded border-slate-300 focus:ring-violet-500"
        />
        <label htmlFor={`edit-isRequired-${prop.id}`} className="text-sm text-slate-700">Required property</label>
      </div>
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={updateProperty.isPending}
          className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
        >
          {updateProperty.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-sm text-slate-500 hover:text-slate-700 px-5 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Example schema template ──────────────────────────────────────────────────

// ─── Share modal ─────────────────────────────────────────────────────────────

function downloadTextFile(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function ShareModal({ schema, onClose }: { schema: OntologySchema; onClose: () => void }) {
  const [shareUrl, setShareUrl] = useState<string | null | 'pending'>('pending');
  const [copied, setCopied] = useState(false);
  const exportFile = useMemo(() => serializeSchema(schema), [schema]);

  useEffect(() => {
    let cancelled = false;
    buildShareUrl(exportFile)
      .then((url) => { if (!cancelled) setShareUrl(url); })
      .catch(() => { if (!cancelled) setShareUrl(null); });
    return () => { cancelled = true; };
  }, [exportFile]);

  function copyLink() {
    if (typeof shareUrl !== 'string') return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function downloadJson() {
    const safeTitle = schema.title.replace(/[^\w-]+/g, '_').slice(0, 60) || 'schema';
    downloadTextFile(`${safeTitle}.sulo-schema.json`, JSON.stringify(exportFile, null, 2), 'application/json');
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="font-semibold text-slate-800 text-lg">Share “{schema.title}”</h2>
          <p className="text-sm text-slate-500 mt-1">
            Your schemas are stored on the server. To hand this one to someone else — or move it
            to another machine — share a link or a file. Importing always creates an independent
            copy, so later edits to either side stay separate.
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-700">Share link</div>
          {shareUrl === 'pending' && <div className="text-sm text-slate-400">Preparing link…</div>}
          {shareUrl === null && (
            <div className="text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              This schema is too large for a link — use the file export below instead.
            </div>
          )}
          {typeof shareUrl === 'string' && (
            <div className="flex gap-2 items-center">
              <input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-600 bg-slate-50"
              />
              <button
                onClick={copyLink}
                className="bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors shrink-0"
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-700">File</div>
          <button
            onClick={downloadJson}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium px-4 py-1.5 rounded-lg transition-colors border border-slate-300"
          >
            Download .json
          </button>
          <p className="text-xs text-slate-400">
            Also your backup: importing this file restores the schema on any machine.
          </p>
        </div>

        <div className="flex justify-end">
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-1.5">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── List page ────────────────────────────────────────────────────────────────

function SchemaListPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingShare, setPendingShare] = useState<SchemaExport | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { status: authStatus } = useAuth();
  const [scope, setScope] = useState<'mine' | 'shared' | 'public'>('mine');
  // The desktop/SQLite build has no scope at all (undefined — the server
  // ignores the param); a signed-in web caller gets whichever tab they
  // picked; an anonymous one is pinned to `public`, the only scope that
  // does not 401 without a session (see modules/schemas/routes.ts).
  const effectiveScope: 'mine' | 'shared' | 'public' | undefined =
    authStatus === 'disabled' ? undefined : authStatus === 'authenticated' ? scope : 'public';
  const schemasQuery = useOntologySchemas(effectiveScope, authStatus !== 'loading');
  const createMutation = useCreateOntologySchema();
  const deleteMutation = useDeleteOntologySchema();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // A visited share link carries the schema in the URL fragment (#s=…), which
  // never reaches the server. Decode it and offer the import explicitly —
  // nothing is written until the user confirms.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith(SHARE_FRAGMENT_PREFIX)) return;
    decodeShareFragment(hash.slice(SHARE_FRAGMENT_PREFIX.length))
      .then(setPendingShare)
      .catch((err: unknown) => setImportError(err instanceof Error ? err.message : 'Could not read the share link.'));
    // Consume the fragment so a refresh doesn't re-prompt.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  async function runImport(file: SchemaExport) {
    setIsImporting(true);
    setImportError(null);
    try {
      const { id } = await importSchemaExport(file);
      await queryClient.invalidateQueries({ queryKey: ['ontology-schemas'] });
      setPendingShare(null);
      navigate(`/ontology/${id}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setIsImporting(false);
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setImportError(null);
    try {
      await runImport(parseSchemaExport(await file.text()));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
    }
  }

  const form = useForm<NewSchemaForm>({
    resolver: zodResolver(NewSchemaFormSchema),
    defaultValues: { title: '', description: '', upperOntologyIri: 'https://w3id.org/sulo/', baseUri: '' },
  });

  async function onSubmit(values: NewSchemaForm) {
    const result = await createMutation.mutateAsync({
      title: values.title,
      description: values.description || undefined,
      upperOntologyIri: values.upperOntologyIri || undefined,
      baseUri: values.baseUri || undefined,
    });
    form.reset();
    setShowCreate(false);
    navigate(`/ontology/${result.id}`);
  }

  return (
    <div className="space-y-7">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight">Schema Builder</h1>
          <p className="text-slate-500 mt-1">
            Define classes and properties for your domain, mapped to an upper-level ontology.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleImportFile}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            className="bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors border border-slate-300"
            title="Import a schema from a .sulo-schema.json export"
          >
            {isImporting ? 'Importing…' : 'Import'}
          </button>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            + New Schema
          </button>
        </div>
      </div>

      {/* Shared-link import prompt */}
      {pendingShare && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4 flex items-center justify-between gap-4">
          <div className="text-sm text-slate-700">
            Someone shared the schema <span className="font-semibold">“{pendingShare.schema.title}”</span> with
            you ({pendingShare.schema.classes.length} classes, {pendingShare.schema.properties.length} properties).
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => runImport(pendingShare)}
              disabled={isImporting}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
            >
              {isImporting ? 'Importing…' : 'Import'}
            </button>
            <button
              onClick={() => setPendingShare(null)}
              className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-white transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {importError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-600">
          {importError}
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="bg-violet-50 border border-violet-200 rounded-xl shadow-sm p-6 space-y-4">
          <div>
            <h2 className="font-semibold text-slate-800 text-lg">Create a new ontology</h2>
            <p className="text-sm text-slate-500 mt-0.5">Give your ontology a title, then add classes and properties to it.</p>
          </div>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FieldRow label="Ontology title *" error={form.formState.errors.title?.message}>
              <Input
                {...form.register('title')}
                autoFocus
                placeholder="e.g. Patient Health Record Ontology"
              />
            </FieldRow>
            <FieldRow label="Description" error={form.formState.errors.description?.message}>
              <Textarea {...form.register('description')} placeholder="What domain does this ontology cover?" />
            </FieldRow>
            <FieldRow label="Upper-level ontology IRI (optional)" error={form.formState.errors.upperOntologyIri?.message}>
              <Input
                {...form.register('upperOntologyIri')}
                placeholder="e.g. https://w3id.org/sulo/"
              />
              <p className="text-xs text-slate-400 mt-1">
                The upper-level ontology your classes and properties will be aligned to — e.g. SULO, BioLink, schema.org.
              </p>
            </FieldRow>
            <FieldRow label="Base URI (optional)" error={form.formState.errors.baseUri?.message}>
              <Input
                {...form.register('baseUri')}
                placeholder="e.g. https://example.org/my-ontology/"
              />
              <p className="text-xs text-slate-400 mt-1">
                Overrides the auto-generated namespace all classes and properties are minted under.
              </p>
            </FieldRow>
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
              >
                {createMutation.isPending ? 'Creating…' : 'Create ontology'}
              </button>
              <button
                type="button"
                onClick={() => { setShowCreate(false); form.reset(); }}
                className="text-sm text-slate-500 hover:text-slate-700 px-5 py-2 rounded-lg border border-slate-200 hover:bg-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Scope tabs — hidden entirely on the desktop/SQLite build, which has
          no notion of scope at all. An anonymous visitor gets one,
          non-interactive "Public" tab rather than three where two would
          only ever 401 (see the SCOPE_TABS comment above). */}
      {authStatus !== 'disabled' && (
        <div className="flex gap-1 border-b border-slate-200">
          {SCOPE_TABS.filter((t) => authStatus === 'authenticated' || t.value === 'public').map((t) => (
            <button
              key={t.value}
              onClick={() => authStatus === 'authenticated' && setScope(t.value)}
              className={`px-5 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
                effectiveScope === t.value
                  ? 'bg-white border border-b-white border-slate-200 text-violet-700 -mb-px'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              } ${authStatus === 'authenticated' ? '' : 'cursor-default'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {schemasQuery.isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-400 text-sm">Loading…</div>
      )}
      {schemasQuery.isError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-600">
          Failed to load ontology schemas.
        </div>
      )}

      <div className="space-y-3">
        {schemasQuery.data?.map((schema) => (
          <div
            key={schema.id}
            className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-4 flex items-start justify-between hover:border-violet-300 hover:shadow-md transition-all"
          >
            <Link to={`/ontology/${schema.id}`} className="flex-1 min-w-0 group">
              <div className="font-semibold text-slate-800 group-hover:text-violet-700 transition-colors">
                {schema.title}
              </div>
              {schema.description && (
                <div className="text-sm text-slate-500 mt-0.5 truncate">{schema.description}</div>
              )}
              {schema.upperOntologyIri && (
                <div className="text-xs text-slate-400 mt-1">
                  Upper ontology:{' '}
                  <span className="font-mono text-violet-600">{schema.upperOntologyIri}</span>
                </div>
              )}
              {schema.baseUri && (
                <div className="text-xs text-slate-400 mt-1">
                  Base URI:{' '}
                  <span className="font-mono text-violet-600">{schema.baseUri}</span>
                </div>
              )}
            </Link>
            {/* Only in scopes where every listed schema is guaranteed to be
                one the caller owns — a delete attempt on a shared/public
                entry would only 403/404 (see modules/schemas/routes.ts). */}
            {(effectiveScope === undefined || effectiveScope === 'mine') && (
              <button
                onClick={() => {
                  if (confirm(`Delete "${schema.title}"?`)) deleteMutation.mutate(schema.id);
                }}
                className="text-slate-400 hover:text-red-500 text-sm ml-4 shrink-0 transition-colors"
                title="Delete schema"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {schemasQuery.data?.length === 0 && !showCreate && (
        <div className="text-center py-20 text-slate-400 text-sm">
          {authStatus === 'anonymous' ? (
            // POST /ontology-schemas is 401 without a session (routes.auth.test.ts),
            // so an anonymous visitor who lands here with no public schemas must
            // not be invited into a form that can only fail.
            <>No public ontologies yet. Sign in to create one.</>
          ) : (
            <>
              No ontology schemas yet.{' '}
              <button onClick={() => setShowCreate(true)} className="text-violet-600 hover:underline">
                Create one
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Detail / Builder page ────────────────────────────────────────────────────

function SchemaDetailPage({ id }: { id: string }) {
  const { status: authStatus } = useAuth();
  const schemaQuery    = useOntologySchema(id);
  const updateSchema   = useUpdateOntologySchema(id);
  const addClass       = useAddOntologyClass(id);
  const deleteClass    = useDeleteOntologyClass(id);
  const addProperty    = useAddOntologyProperty(id);
  const deleteProperty = useDeleteOntologyProperty(id);

  const hasUpperOntology = !!schemaQuery.data?.upperOntologyIri;
  const upperConceptsQuery = useUpperConcepts(id, hasUpperOntology);

  const [showAddClass, setShowAddClass] = useState(false);
  const [showAddProperty, setShowAddProperty] = useState(false);
  const [activeTab, setActiveTab] = useState<'classes' | 'properties'>('classes');
  const [editingMeta, setEditingMeta] = useState(false);
  const [showExport, setShowExport]   = useState(false);
  const [showConsistency, setShowConsistency] = useState(false);
  const [showDiagram, setShowDiagram] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [editingClassId, setEditingClassId] = useState<string | null>(null);
  const [editingPropId, setEditingPropId] = useState<string | null>(null);

  const classForm = useForm<NewClassForm>({
    resolver: zodResolver(NewClassFormSchema),
    defaultValues: { name: '', label: '', description: '', mapsToConceptIri: '' as string | undefined, superClassId: '' },
  });

  const propertyForm = useForm<NewPropertyForm>({
    resolver: zodResolver(NewPropertyFormSchema),
    defaultValues: {
      name: '', label: '', description: '',
      propertyType: 'datatype', domainClassId: '', rangeClassIri: '',
      mappingPattern: [], regexPattern: '', regexVariable: '', isRequired: false,
      propertyFeatures: [], inversePropertyIri: '', disjointPropertyIris: [],
    },
  });

  const metaForm = useForm<EditSchemaForm>({
    resolver: zodResolver(EditSchemaFormSchema),
    defaultValues: { title: '', description: '', upperOntologyIri: '', baseUri: '' },
  });

  // Populate meta form when schema loads
  useEffect(() => {
    if (schemaQuery.data) {
      metaForm.reset({
        title: schemaQuery.data.title,
        description: schemaQuery.data.description ?? '',
        upperOntologyIri: schemaQuery.data.upperOntologyIri ?? '',
        baseUri: schemaQuery.data.baseUri ?? '',
      });
    }
  }, [schemaQuery.data]);

  const watchPropertyType = propertyForm.watch('propertyType');

  async function onSaveMeta(values: EditSchemaForm) {
    await updateSchema.mutateAsync({
      title: values.title,
      description: values.description || undefined,
      upperOntologyIri: values.upperOntologyIri || undefined,
      baseUri: values.baseUri || undefined,
    });
    setEditingMeta(false);
  }

  async function onAddClass(values: NewClassForm) {
    await addClass.mutateAsync({
      name: values.name,
      label: values.label || undefined,
      description: values.description || undefined,
      mapsToConceptIri: (values.mapsToConceptIri as string) || undefined,
      superClassId: values.superClassId || undefined,
    });
    classForm.reset();
    setShowAddClass(false);
  }

  async function onAddProperty(values: NewPropertyForm) {
    await addProperty.mutateAsync({
      name: values.name,
      label: values.label || undefined,
      description: values.description || undefined,
      propertyType: values.propertyType,
      domainClassId: values.domainClassId || undefined,
      rangeClassIri: values.rangeClassIri || undefined,
      mappingPattern: (values.mappingPattern ?? []).filter((t) => t.predicate),
      regexPattern: values.regexPattern || undefined,
      regexVariable: values.regexVariable || undefined,
      isRequired: values.isRequired,
      propertyFeatures: (values.propertyFeatures ?? []) as import('../api/ontology').PropertyFeature[],
      inversePropertyIri: values.inversePropertyIri || undefined,
      disjointPropertyIris: values.disjointPropertyIris ?? [],
    });
    propertyForm.reset();
    setShowAddProperty(false);
  }

  if (schemaQuery.isLoading) {
    return <div className="flex items-center justify-center py-20 text-slate-400 text-sm">Loading…</div>;
  }
  if (schemaQuery.isError || !schemaQuery.data) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-600">
        Failed to load ontology schema.
      </div>
    );
  }

  const schema = schemaQuery.data;
  const classes: OntologyClass[] = schema.classes;

  return (
    <div className="space-y-7">
      {/* Header */}
      <div>
        <Link to="/ontology" className="text-sm text-slate-400 hover:text-violet-600 transition-colors">
          ← All ontologies
        </Link>

        {!editingMeta ? (
          <div className="mt-2 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-800 tracking-tight">{schema.title}</h1>
              {schema.description && <p className="text-slate-500 mt-1">{schema.description}</p>}
              {schema.upperOntologyIri && (
                <div className="mt-2 inline-flex items-center gap-2 bg-violet-50 border border-violet-100 rounded-full px-3 py-1 text-xs text-violet-700">
                  <span className="font-medium">Upper-level ontology:</span>
                  <a href={schema.upperOntologyIri} target="_blank" rel="noreferrer" className="font-mono hover:underline">
                    {schema.upperOntologyIri}
                  </a>
                </div>
              )}
              {schema.baseUri && (
                <div className="mt-2 ml-2 inline-flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-full px-3 py-1 text-xs text-slate-600">
                  <span className="font-medium">Base URI:</span>
                  <span className="font-mono">{schema.baseUri}</span>
                </div>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => setShowDiagram(true)}
                className="bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
              >
                Diagram
              </button>
              <button
                onClick={() => setShowExport(true)}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
              >
                Generate ↓
              </button>
              {/* The mirror image of the badge above: this modal reasons
                  over client-supplied Turtle via POST /reason, which plan 4
                  task 6 deliberately un-registers in postgres mode (spec §7
                  — the server must not spawn a JVM over bytes a caller
                  chose there). Desktop-only, where that route still exists
                  because the reasoner is the user's own machine. */}
              {authStatus === 'disabled' && (
                <button
                  onClick={() => setShowConsistency(true)}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
                >
                  Check consistency
                </button>
              )}
              <button
                onClick={() => setShowShare(true)}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium px-4 py-1.5 rounded-lg transition-colors border border-slate-300"
                title="Share this schema as a link or a .json file"
              >
                Share
              </button>
              {/* Sharing/ACL is a Postgres-only feature (see modules/acl) —
                  hidden on the desktop build and for an anonymous visitor,
                  who could never reach `own` to use it. */}
              {authStatus === 'authenticated' && (
                <button
                  onClick={() => setShowAccess(true)}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium px-4 py-1.5 rounded-lg transition-colors border border-slate-300"
                  title="Manage who can view, edit or own this schema"
                >
                  Manage access
                </button>
              )}
              <button
                onClick={() => setEditingMeta(true)}
                className="text-sm text-slate-400 hover:text-violet-600 border border-slate-200 hover:border-violet-300 px-3 py-1.5 rounded-lg transition-colors"
              >
                Edit info
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 bg-violet-50 border border-violet-200 rounded-xl p-5 space-y-4">
            <h3 className="font-semibold text-slate-800">Edit ontology info</h3>
            <form onSubmit={metaForm.handleSubmit(onSaveMeta)} className="space-y-4">
              <FieldRow label="Ontology title *" error={metaForm.formState.errors.title?.message}>
                <Input {...metaForm.register('title')} autoFocus />
              </FieldRow>
              <FieldRow label="Description" error={metaForm.formState.errors.description?.message}>
                <Textarea {...metaForm.register('description')} />
              </FieldRow>
              <FieldRow label="Upper-level ontology IRI" error={metaForm.formState.errors.upperOntologyIri?.message}>
                <Input
                  {...metaForm.register('upperOntologyIri')}
                  placeholder="e.g. https://w3id.org/sulo/"
                />
                <p className="text-xs text-slate-400 mt-1">
                  The upper-level ontology your classes and properties will be aligned to.
                </p>
              </FieldRow>
              <FieldRow label="Base URI" error={metaForm.formState.errors.baseUri?.message}>
                <Input
                  {...metaForm.register('baseUri')}
                  placeholder="e.g. https://example.org/my-ontology/"
                />
                <p className="text-xs text-slate-400 mt-1">
                  Overrides the auto-generated namespace all classes and properties are minted under.
                </p>
              </FieldRow>
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={updateSchema.isPending}
                  className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
                >
                  {updateSchema.isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditingMeta(false); metaForm.reset(); }}
                  className="text-sm text-slate-500 hover:text-slate-700 px-5 py-2 rounded-lg border border-slate-200 hover:bg-white transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* Consistency overview — full width, not squeezed into the header's
          title column: this is the schema's single most important status
          line, and it needs room for a whole clash explanation once expanded.
          The automatic, server-side badge needs GET/POST .../report, which
          exist only in postgres mode (plan 4 task 6) — `authStatus ===
          'disabled'` is that mode's own signal (config/auth.ts: auth is
          enabled if and only if storage === 'postgres'), so this must not
          render in the desktop build, where those routes 404. */}
      {authStatus !== 'disabled' && (
        <ConsistencyBadge schemaId={schema.id} authStatus={authStatus} />
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-4">
          <div className="text-2xl font-bold text-slate-800">{schema.classes.length}</div>
          <div className="text-sm text-slate-500">Classes</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-4">
          <div className="text-2xl font-bold text-slate-800">{schema.properties.length}</div>
          <div className="text-sm text-slate-500">Properties</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-4">
          <div className="text-2xl font-bold text-slate-800">
            {schema.classes.filter((c) => c.mapsToConceptIri).length +
              schema.properties.filter((p) => p.mappingPattern.length > 0).length}
          </div>
          <div className="text-sm text-slate-500">Mapped concepts</div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-slate-200">
        {(['classes', 'properties'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-5 py-2.5 text-sm font-medium rounded-t-lg transition-colors capitalize ${
              activeTab === t
                ? 'bg-white border border-b-white border-slate-200 text-violet-700 -mb-px'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Classes tab ── */}
      {activeTab === 'classes' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowAddClass(!showAddClass)}
              className="bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              + Add Class
            </button>
          </div>

          {showAddClass && (
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4">
              <h3 className="font-semibold text-slate-800">New Class</h3>
              <form onSubmit={classForm.handleSubmit(onAddClass)} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FieldRow label="Name *" error={classForm.formState.errors.name?.message}>
                    <Input {...classForm.register('name')} placeholder="e.g. Patient" />
                  </FieldRow>
                  <FieldRow label="Label" error={classForm.formState.errors.label?.message}>
                    <Input {...classForm.register('label')} placeholder="Human-readable label" />
                  </FieldRow>
                </div>
                <FieldRow label="Description" error={classForm.formState.errors.description?.message}>
                  <Textarea {...classForm.register('description')} placeholder="What does this class represent?" />
                </FieldRow>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FieldRow label="Maps to concept IRI" error={classForm.formState.errors.mapsToConceptIri?.message}>
                    <Controller
                      control={classForm.control}
                      name="mapsToConceptIri"
                      render={({ field }) => (
                        <ConceptCombobox
                          value={field.value ?? ''}
                          onChange={field.onChange}
                          concepts={(upperConceptsQuery.data ?? []).filter(c => c.type === 'class')}
                          loading={upperConceptsQuery.isLoading}
                          placeholder={hasUpperOntology ? 'Search upper-ontology classes…' : 'e.g. https://w3id.org/sulo/Person'}
                        />
                      )}
                    />
                    {!hasUpperOntology && (
                      <p className="text-xs text-slate-400 mt-1">
                        Set an upper-level ontology IRI on this schema to get autocomplete suggestions.
                      </p>
                    )}
                    {upperConceptsQuery.isError && (
                      <p className="text-xs text-amber-500 mt-1">
                        Could not load concepts from the upper ontology — enter an IRI manually.
                      </p>
                    )}
                  </FieldRow>
                  <FieldRow label="Subclass of" error={classForm.formState.errors.superClassId?.message}>
                    <select
                      {...classForm.register('superClassId')}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 bg-white"
                    >
                      <option value="">— none —</option>
                      {schema.classes.map((c) => (
                        <option key={c.id} value={c.id}>{c.label ?? c.name}</option>
                      ))}
                    </select>
                  </FieldRow>
                </div>
                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={addClass.isPending}
                    className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
                  >
                    {addClass.isPending ? 'Adding…' : 'Add Class'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowAddClass(false); classForm.reset(); }}
                    className="text-sm text-slate-500 hover:text-slate-700 px-5 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="space-y-3">
            {classes.map((cls) => (
              <div
                key={cls.id}
                className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-4"
              >
                {editingClassId === cls.id ? (
                  <EditClassForm
                    cls={cls}
                    schemaId={id}
                    allClasses={schema.classes}
                    concepts={upperConceptsQuery.data ?? []}
                    conceptsLoading={upperConceptsQuery.isLoading}
                    hasUpperOntology={hasUpperOntology}
                    onDone={() => setEditingClassId(null)}
                  />
                ) : (
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-slate-800">{cls.name}</span>
                        {cls.label && cls.label !== cls.name && (
                          <span className="text-slate-500 text-sm">— {cls.label}</span>
                        )}
                      </div>
                      {cls.description && (
                        <div className="text-sm text-slate-500 mt-0.5">{cls.description}</div>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {cls.superClassId && (() => {
                          const superCls = schema.classes.find((c) => c.id === cls.superClassId);
                          return superCls ? (
                            <span className="inline-flex items-center gap-1 bg-slate-100 border border-slate-200 text-slate-600 text-xs px-2 py-0.5 rounded-full font-medium">
                              ⊆ {superCls.label ?? superCls.name}
                            </span>
                          ) : null;
                        })()}
                        {cls.mapsToConceptIri && (
                          <a
                            href={cls.mapsToConceptIri}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 bg-violet-50 border border-violet-100 text-violet-700 text-xs px-2 py-0.5 rounded-full font-medium hover:bg-violet-100 transition-colors"
                          >
                            ↗ {cls.mapsToConceptIri.split('/').pop() ?? cls.mapsToConceptIri}
                          </a>
                        )}
                      </div>
                      {(() => {
                        const seen = new Set<string>();
                        const own = schema.properties.filter((p) => {
                          if (p.domainClassId !== cls.id || seen.has(p.name)) return false;
                          seen.add(p.name);
                          return true;
                        });
                        if (!own.length) return null;
                        return (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {own.map((p) => (
                              <button
                                key={p.id}
                                onClick={() => { setActiveTab('properties'); setEditingPropId(p.id); }}
                                className="text-[10px] font-mono bg-violet-50 border border-violet-100 text-violet-700 px-1.5 py-0.5 rounded hover:bg-violet-100 hover:border-violet-300 transition-colors"
                                title={`Edit property ${p.name}`}
                              >
                                {p.name}
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                      {(() => {
                        const inherited = cls.superClassId
                          ? schema.properties.filter((p) => p.domainClassId === cls.superClassId)
                          : [];
                        if (!inherited.length) return null;
                        return (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {inherited.map((p) => (
                              <span
                                key={p.id}
                                className="text-[10px] font-mono bg-slate-50 border border-slate-200 text-slate-400 px-1.5 py-0.5 rounded italic"
                                title={`Inherited from ${schema.classes.find(c => c.id === cls.superClassId)?.name}`}
                              >
                                ↑ {p.name}
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="flex gap-2 ml-4 shrink-0">
                      <button
                        onClick={() => setEditingClassId(cls.id)}
                        className="text-slate-400 hover:text-violet-600 text-xs border border-slate-200 hover:border-violet-300 px-2 py-1 rounded-md transition-colors"
                        title="Edit class"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteClass.mutate(cls.id)}
                        className="text-slate-400 hover:text-red-500 text-sm transition-colors"
                        title="Remove class"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {classes.length === 0 && !showAddClass && (
              <div className="text-center py-12 text-slate-400 text-sm">
                No classes yet.{' '}
                <button onClick={() => setShowAddClass(true)} className="text-violet-600 hover:underline">
                  Add one
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Properties tab ── */}
      {showExport  && <ExportModal    schema={schema} onClose={() => setShowExport(false)}  />}
      {showConsistency && <ConsistencyModal schema={schema} onClose={() => setShowConsistency(false)} />}
      {showShare   && <ShareModal     schema={schema} onClose={() => setShowShare(false)}   />}
      {showAccess  && <ShareDialog    schema={schema} onClose={() => setShowAccess(false)}  />}
      {showDiagram && <UmlDiagramView schema={schema} onClose={() => setShowDiagram(false)} />}

      {activeTab === 'properties' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowAddProperty(!showAddProperty)}
              className="bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              + Add Property
            </button>
          </div>

          {showAddProperty && (
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4">
              <h3 className="font-semibold text-slate-800">New Property</h3>
              <form onSubmit={propertyForm.handleSubmit(onAddProperty)} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FieldRow label="Name *" error={propertyForm.formState.errors.name?.message}>
                    <Input {...propertyForm.register('name')} placeholder="e.g. hasAge" />
                  </FieldRow>
                  <FieldRow label="Label" error={propertyForm.formState.errors.label?.message}>
                    <Input {...propertyForm.register('label')} placeholder="Human-readable label" />
                  </FieldRow>
                </div>

                <FieldRow label="Description" error={propertyForm.formState.errors.description?.message}>
                  <Textarea {...propertyForm.register('description')} placeholder="What does this property describe?" />
                </FieldRow>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FieldRow label="Property type" error={propertyForm.formState.errors.propertyType?.message}>
                    <select
                      {...propertyForm.register('propertyType')}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                    >
                      <option value="datatype">Datatype property (literal value)</option>
                      <option value="object">Object property (links to a class)</option>
                    </select>
                  </FieldRow>

                  <FieldRow label="Domain class" error={propertyForm.formState.errors.domainClassId?.message}>
                    <select
                      {...propertyForm.register('domainClassId')}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                    >
                      <option value="">— any class —</option>
                      {classes.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </FieldRow>
                </div>

                <FieldRow label="Range" error={propertyForm.formState.errors.rangeClassIri?.message}>
                  {watchPropertyType === 'datatype' ? (
                    <select
                      {...propertyForm.register('rangeClassIri')}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                    >
                      <option value="">— select XSD type —</option>
                      {XSD_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  ) : (
                    <select
                      {...propertyForm.register('rangeClassIri')}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                    >
                      <option value="">— select target class —</option>
                      {classes.map((c) => (
                        <option key={c.id} value={c.url}>{c.name}</option>
                      ))}
                    </select>
                  )}
                </FieldRow>

                <FieldRow label="Mapping pattern" error={undefined}>
                  <p className="text-xs text-slate-400 mb-2">
                    Define how this property maps to the upper-level ontology using one or more triple templates.
                    Use <span className="font-mono">?this</span> as the subject of the first triple and
                    <span className="font-mono"> ?value</span> as the object of the final triple.
                    Chain through intermediate variables (<span className="font-mono">?o1</span>, <span className="font-mono">?o2</span>…) for multi-hop patterns.
                  </p>
                  <Controller
                    control={propertyForm.control}
                    name="mappingPattern"
                    render={({ field }) => (
                      <TriplePatternEditor
                        value={field.value ?? []}
                        onChange={field.onChange}
                        concepts={upperConceptsQuery.data ?? []}
                        classes={classes}
                        loading={upperConceptsQuery.isLoading}
                      />
                    )}
                  />
                </FieldRow>

                <FieldRow label="Regex extraction (optional)" error={undefined}>
                  <p className="text-xs text-slate-400 mb-1">
                    Extract multiple variables from a single value using named capture groups.
                    Example: <span className="font-mono">{'(?<family>[a-zA-Z]+), (?<given>[a-zA-Z]+)'}</span>
                  </p>
                  <Controller
                    control={propertyForm.control}
                    name="regexVariable"
                    render={({ field: varField }) => (
                      <Controller
                        control={propertyForm.control}
                        name="regexPattern"
                        render={({ field: patField }) => (
                          <RegexPatternInput
                            variable={varField.value ?? ''}
                            onVariableChange={varField.onChange}
                            pattern={patField.value ?? ''}
                            onPatternChange={patField.onChange}
                          />
                        )}
                      />
                    )}
                  />
                </FieldRow>

                <FieldRow label="Property characteristics" error={undefined}>
                  <Controller
                    control={propertyForm.control}
                    name="propertyFeatures"
                    render={({ field: featField }) => (
                      <Controller
                        control={propertyForm.control}
                        name="inversePropertyIri"
                        render={({ field: invField }) => (
                          <Controller
                            control={propertyForm.control}
                            name="disjointPropertyIris"
                            render={({ field: disjField }) => (
                              <PropertyFeaturesEditor
                                propertyType={watchPropertyType}
                                features={featField.value ?? []}
                                onChange={featField.onChange}
                                inverseIri={invField.value ?? ''}
                                onInverseIriChange={invField.onChange}
                                disjointPropertyIris={disjField.value ?? []}
                                onDisjointChange={disjField.onChange}
                                availableProperties={(schema.properties ?? [])
                                  .map((p) => ({ name: p.name, url: p.url }))}
                              />
                            )}
                          />
                        )}
                      />
                    )}
                  />
                </FieldRow>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="isRequired"
                    {...propertyForm.register('isRequired')}
                    className="w-4 h-4 text-violet-600 rounded border-slate-300 focus:ring-violet-500"
                  />
                  <label htmlFor="isRequired" className="text-sm text-slate-700">Required property</label>
                </div>

                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={addProperty.isPending}
                    className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
                  >
                    {addProperty.isPending ? 'Adding…' : 'Add Property'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowAddProperty(false); propertyForm.reset(); }}
                    className="text-sm text-slate-500 hover:text-slate-700 px-5 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="space-y-3">
            {/* Group same-name same-domain props so union ranges are shown on one card */}
            {(() => {
              const groups = new Map<string, typeof schema.properties>();
              for (const p of schema.properties) {
                const key = `${p.name}|${p.domainClassId ?? ''}`;
                const g = groups.get(key) ?? [];
                g.push(p);
                groups.set(key, g);
              }
              return Array.from(groups.values());
            })().map((group) => {
              const prop = group[0];
              const domainClass = prop.domainClassId ? classes.find((c) => c.id === prop.domainClassId) : null;
              const rangeLabels = group.map((p) => {
                if (!p.rangeClassIri) return null;
                if (p.rangeClassIri.includes('XMLSchema#')) return 'xsd:' + p.rangeClassIri.split('#')[1];
                return classes.find((c) => c.url === p.rangeClassIri)?.name
                  ?? p.rangeClassIri.split('/').pop()
                  ?? p.rangeClassIri;
              }).filter(Boolean) as string[];
              const rangeLabel = rangeLabels.length > 0 ? rangeLabels.join(' | ') : null;

              return (
                <div
                  key={`${prop.name}|${prop.domainClassId ?? ''}`}
                  className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-4"
                >
                  {editingPropId === prop.id ? (
                    <EditPropertyForm
                      prop={prop}
                      schemaId={id}
                      classes={classes}
                      properties={schema.properties}
                      concepts={upperConceptsQuery.data ?? []}
                      conceptsLoading={upperConceptsQuery.isLoading}
                      onDone={() => setEditingPropId(null)}
                    />
                  ) : (
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-semibold text-slate-800">{prop.name}</span>
                          {prop.label && prop.label !== prop.name && (
                            <span className="text-slate-500 text-sm">— {prop.label}</span>
                          )}
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
                            prop.propertyType === 'object'
                              ? 'bg-blue-50 text-blue-700 border-blue-100'
                              : 'bg-slate-100 text-slate-600 border-slate-200'
                          }`}>
                            {prop.propertyType}
                          </span>
                          {prop.isRequired && (
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 border border-amber-100">
                              required
                            </span>
                          )}
                        </div>
                        {prop.description && (
                          <div className="text-sm text-slate-500 mt-0.5">{prop.description}</div>
                        )}
                        <div className="flex flex-wrap gap-2 mt-1.5 text-xs text-slate-500">
                          {domainClass && (
                            <span>domain: <span className="font-mono text-slate-700">{domainClass.name}</span></span>
                          )}
                          {rangeLabel && (
                            <span>range: <span className="font-mono text-slate-700">{rangeLabel}</span></span>
                          )}
                        </div>
                        {prop.mappingPattern.length > 0 && (
                          <div className="mt-1.5 font-mono text-xs text-slate-500 bg-slate-50 rounded px-2 py-1 leading-relaxed">
                            {prop.mappingPattern.map((triple, i) => {
                              const localPred = triple.predicate.split(/[/#]/).pop() ?? triple.predicate;
                              const localObj  = triple.object.startsWith('?')
                                ? triple.object
                                : (classes.find((c) => c.url === triple.object)?.label
                                    ?? classes.find((c) => c.url === triple.object)?.name
                                    ?? `:${triple.object.split(/[/#]/).pop()}`);
                              return (
                                <span key={i}>
                                  {i > 0 && <span className="text-slate-300"> .<br /></span>}
                                  <span className="text-violet-600">{triple.subject}</span>
                                  {' '}<span className="text-slate-700">{localPred}</span>
                                  {' '}<span className="text-emerald-600">{localObj}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                        {prop.regexPattern && (
                          <div className="mt-1.5 font-mono text-xs text-slate-500 bg-slate-50 rounded px-2 py-1">
                            <span className="text-slate-400">%Map:&#123; </span>
                            {prop.regexVariable && (
                              <><span className="text-emerald-600">?{prop.regexVariable}</span><span className="text-slate-400"> . </span></>
                            )}
                            <span className="text-violet-600">regex(/{prop.regexPattern}/)</span>
                            <span className="text-slate-400"> &#125;</span>
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2 ml-4 shrink-0">
                        <button
                          onClick={() => setEditingPropId(prop.id)}
                          className="text-slate-400 hover:text-violet-600 text-xs border border-slate-200 hover:border-violet-300 px-2 py-1 rounded-md transition-colors"
                          title="Edit property"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => deleteProperty.mutate(prop.id)}
                          className="text-slate-400 hover:text-red-500 text-sm transition-colors"
                          title="Remove property"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {schema.properties.length === 0 && !showAddProperty && (
              <div className="text-center py-12 text-slate-400 text-sm">
                No properties yet.{' '}
                <button onClick={() => setShowAddProperty(true)} className="text-violet-600 hover:underline">
                  Add one
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Router wrapper ───────────────────────────────────────────────────────────

export default function OntologyBuilderPage() {
  const { id } = useParams<{ id?: string }>();
  if (id) return <SchemaDetailPage id={id} />;
  return <SchemaListPage />;
}
