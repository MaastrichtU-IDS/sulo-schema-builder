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
  type OntologyClass,
  type OntologyProperty,
  type OntologySchema,
  type UpperConcept,
  type TripleTemplate,
  type ConsistencyReport,
} from '../api/ontology.js';
import { apiClient } from '../api/client.js';
import {
  extractNamedGroups,
  generateExports,
  buildMermaid,
} from '../lib/ontologyExport.js';
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

interface TriplePatternEditorProps {
  value: TripleTemplate[];
  onChange: (v: TripleTemplate[]) => void;
  concepts: UpperConcept[];
  classes?: OntologyClass[];
  loading?: boolean;
}

function TriplePatternEditor({ value, onChange, concepts, classes, loading }: TriplePatternEditorProps) {
  const propConcepts = useMemo(
    () => concepts.filter((c) => c.type === 'property'),
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
            const localPred = t.predicate.split(/[/#]/).pop() ?? t.predicate;
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

function ConsistencyPanel({ turtleOwl }: { turtleOwl: string }) {
  // Server-side full OWL DL (HermiT) consistency check.
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
  const [serverReport, setServerReport]   = useState<ConsistencyReport | null>(null);
  const [serverState, setServerState]     = useState<'idle' | 'loading' | 'error'>('idle');
  const [serverError, setServerError]     = useState<string>('');

  // Probe whether the backend reasoner is available (controls the button).
  useEffect(() => {
    let alive = true;
    getReasonerStatus()
      .then((s) => { if (alive) setServerEnabled(s.enabled); })
      .catch(() => { if (alive) setServerEnabled(false); });
    return () => { alive = false; };
  }, []);

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
        e.response?.status === 503
          ? 'Server-side reasoning is not available in this deployment.'
          : e.response?.data?.message ?? 'The reasoner could not process this ontology.',
      );
    }
  }

  if (serverEnabled === false) {
    return (
      <div className="min-h-[200px] flex items-center justify-center">
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-xs text-amber-800 max-w-md text-center">
          Server-side OWL DL reasoning is not available in this deployment.
        </div>
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

const SULO = 'https://w3id.org/sulo/';

// A class's canonical IRI falls back to a schema-local IRI whenever
// mapsToConceptIri sits inside the bare SULO namespace — so two independently
// authored schemas' same-meaning Role subclasses (OMOP's PatientRole, FHIR's
// SubjectOfCareRole) never resolve to the same IRI even though both declare
// category "Role", which silently breaks cross-schema round-tripping through
// SULO. Pointing both at a shared, non-SULO-namespaced IRI here (the same
// mechanism already used for external codes like SNOMED) makes them resolve
// identically instead.
const SHARED_ROLES = {
  subjectOfCare: 'https://w3id.org/sulo-schema-builder/roles/SubjectOfCareRole',
  performer: 'https://w3id.org/sulo-schema-builder/roles/PerformerRole',
};

const CLINICAL_EXAMPLE_CLASSES: { name: string; label: string; description: string; mapsToConceptIri: string; superClassName?: string }[] = [
  { name: 'ClinicalVisit',       label: 'Clinical Visit',                description: 'A healthcare encounter between a patient and a provider.',                          mapsToConceptIri: `${SULO}Process` },
  { name: 'Measurement',         label: 'Measurement',                   description: 'The outcome of a laboratory test or diagnostic analysis.',                          mapsToConceptIri: `${SULO}InformationObject` },
  { name: 'MedicalProcedure',    label: 'Medical Procedure',             description: 'A clinical action or intervention performed on a patient.',                         mapsToConceptIri: `${SULO}Process` },
  { name: 'ClinicalCondition',   label: 'Clinical Condition',            description: 'A medical condition, disease, or disorder affecting a patient.',                    mapsToConceptIri: `${SULO}Process` },
  { name: 'Severity',            label: 'Severity',                      description: 'The degree of seriousness of a condition, symptom, or finding.',                    mapsToConceptIri: `${SULO}Quality` },
  { name: 'TreatmentPlan',       label: 'Treatment / Treatment Plan',    description: 'A drug administration event or planned course of treatment.',                       mapsToConceptIri: `${SULO}Process` },
  { name: 'SubjectOfCareRole',   label: 'Subject of Care Role',          description: 'The role played by a person who is the subject of a care activity.',                mapsToConceptIri: `${SULO}Role` },
  { name: 'CareProviderRole',    label: 'Care Provider Role',            description: 'The role played by a person or organisation providing care.',                        mapsToConceptIri: `${SULO}Role` },
  { name: 'Person',              label: 'Person',                        description: 'A human being, either as a patient or a care participant.',                          mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'AnatomicalStructure', label: 'Anatomical Structure',          description: 'A body part or anatomical site relevant to a clinical finding or procedure.',        mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'PerformerRole',       label: 'Performer Role',                description: 'The role of an agent who performs a clinical action or procedure.',                  mapsToConceptIri: `${SULO}Role` },
  { name: 'ProcessStatus',       label: 'Process Status',                description: 'The state or status of a clinical process or workflow step.',                        mapsToConceptIri: `${SULO}Quality` },
  { name: 'PharmaceuticalDose',  label: 'Pharmaceutical Dose',           description: 'The quantity and form of a drug administered in a single instance.',                 mapsToConceptIri: `${SULO}Quantity` },
  { name: 'OutputRole',          label: 'Output Role',                   description: 'The role of an entity produced as an output of a clinical process.',                 mapsToConceptIri: `${SULO}Role` },
  { name: 'InstrumentRole',      label: 'Instrument Role',               description: 'The role of a device or tool used in a clinical procedure.',                         mapsToConceptIri: `${SULO}Role` },
  { name: 'CareUnit',            label: 'Care Unit',                     description: 'An organisational unit responsible for delivering a type of care.',                  mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'MeasurementProcess',        label: 'Measurement Process',        description: 'A process of measuring or quantifying a clinical observable or parameter.',           mapsToConceptIri: `${SULO}Process`,        superClassName: 'MedicalProcedure' },
  { name: 'Device',             label: 'Device',                        description: 'A physical instrument or medical device used in a clinical or diagnostic process.',      mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'CarePlan',            label: 'Care Plan',                     description: 'A structured set of intended actions or treatments for a patient.',                          mapsToConceptIri: `${SULO}InformationObject` },
  { name: 'Occupation',         label: 'Occupation',                    description: 'A job, profession, or occupational role held by a person.',                                  mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'EvaluationProcess',         label: 'Evaluation Process',         description: 'A process of assessing or evaluating a clinical finding, condition, or patient state.',      mapsToConceptIri: `${SULO}Process`,        superClassName: 'MedicalProcedure' },
  { name: 'MedicationAdministration',  label: 'Medication Administration',  description: 'A process of administering a drug or pharmaceutical substance to a patient.',                 mapsToConceptIri: `${SULO}Process`,        superClassName: 'MedicalProcedure' },
  { name: 'PharmaceuticalProduct',    label: 'Pharmaceutical Product',        description: 'A drug or medicinal product used in the treatment or prevention of disease.',                   mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'PharmaceuticalDoseForm',   label: 'Pharmaceutical Dose Form',      description: 'The physical form of a pharmaceutical product (e.g. tablet, capsule, solution).',              mapsToConceptIri: `${SULO}Quality` },
  { name: 'DiagnosticStatement',      label: 'Diagnostic Statement',          description: 'An information object representing a diagnostic finding or clinical assertion.',                   mapsToConceptIri: `${SULO}InformationObject` },
  { name: 'Code',             label: 'Code',              description: 'A terminology code bundling an identifier, its coding system/version, and an optional display name.',  mapsToConceptIri: `${SULO}InformationObject` },
  { name: 'ObservableEntity', label: 'Observable Entity', description: 'A SNOMED CT observable entity — a concept that can be measured or observed in a clinical or scientific context.',  mapsToConceptIri: 'http://snomed.info/id/363787002', superClassName: 'Code' },
  { name: 'SCT_Procedure',    label: 'SCT Procedure',    description: 'A SNOMED CT procedure concept — a clinical action or intervention performed on or for a patient.',               mapsToConceptIri: 'http://snomed.info/id/71388002',  superClassName: 'Code' },
  // Classes adopted from the SPHN schema
  { name: 'AdministrativeCase', label: 'Administrative Case', description: 'An administrative hospital case grouping a patient’s clinical visits.',          mapsToConceptIri: `${SULO}Process` },
  { name: 'Sample',             label: 'Sample',              description: 'A biological specimen collected from a patient for laboratory analysis.',          mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'Substance',          label: 'Substance',           description: 'A material substance, e.g. the active ingredient of a pharmaceutical product.',    mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'DrugPrescription',   label: 'Drug Prescription',   description: 'An information object representing a prescription or order for a drug.',            mapsToConceptIri: `${SULO}InformationObject` },
];

// ─── OMOP example schema ─────────────────────────────────────────────────────

const OMOP_EXAMPLE_CLASSES: { name: string; label: string; description: string; mapsToConceptIri: string; superClassName?: string }[] = [
  // Core clinical event tables
  { name: 'VisitOccurrence',      label: 'Visit Occurrence',       description: 'A healthcare encounter between a person and the healthcare system.',                            mapsToConceptIri: `${SULO}Process` },
  { name: 'ConditionOccurrence',  label: 'Condition Occurrence',   description: 'A record of a disease, injury, or medical condition observed in a person.',                    mapsToConceptIri: `${SULO}Process` },
  { name: 'DrugExposure',         label: 'Drug Exposure',          description: 'A record of a drug or vaccine administered to or ingested by a person.',                        mapsToConceptIri: `${SULO}Process` },
  { name: 'Measurement',          label: 'Measurement',            description: 'A structured result obtained through systematic examination or testing (lab, vital signs).',    mapsToConceptIri: `${SULO}InformationObject` },
  { name: 'ProcedureOccurrence',  label: 'Procedure Occurrence',   description: 'A record of an activity or process ordered or carried out on a person.',                        mapsToConceptIri: `${SULO}Process` },
  { name: 'Observation',          label: 'Observation',            description: 'A clinical fact about a person not captured in other tables (e.g. smoking status, BMI).',       mapsToConceptIri: `${SULO}InformationObject` },
  { name: 'DeviceExposure',       label: 'Device Exposure',        description: 'Exposure to a foreign physical object used for diagnostic or therapeutic purposes.',             mapsToConceptIri: `${SULO}Process` },
  // Supporting entities
  { name: 'Person',               label: 'Person',                 description: 'A person who is the subject of health-related data.',                                            mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'Provider',             label: 'Provider',               description: 'A healthcare provider (clinician, nurse, etc.) who delivers care.',                              mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'CareSite',             label: 'Care Site',              description: 'A uniquely identified healthcare delivery location or organisational unit.',                      mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'Location',             label: 'Location',               description: 'A physical or geographic address associated with a care site or person.',                         mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'Concept',              label: 'Concept',                description: 'A standardised vocabulary concept (SNOMED-CT, RxNorm, LOINC, etc.) used to express clinical data.', mapsToConceptIri: `${SULO}InformationObject` },
  { name: 'DrugProduct',          label: 'Drug Product',           description: 'A pharmaceutical substance or drug formulation identified by a vocabulary concept.',              mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'Device',               label: 'Device',                 description: 'A medical device or instrument used in diagnosis or therapy.',                                    mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'Specimen',             label: 'Specimen',               description: 'A biological specimen collected from a person for laboratory analysis.',                          mapsToConceptIri: `${SULO}SpatialObject` },
  // Roles (used in Pattern B participant chains)
  { name: 'PatientRole',          label: 'Patient Role',           description: 'The role played by a person as the subject of a clinical event.',                                mapsToConceptIri: SHARED_ROLES.subjectOfCare },
  { name: 'ProviderRole',         label: 'Provider Role',          description: 'The role played by a provider who participates in a clinical event.',                            mapsToConceptIri: SHARED_ROLES.performer },
  { name: 'OutputRole',           label: 'Output Role',            description: 'The role of an entity produced as an output of a clinical process.',                             mapsToConceptIri: `${SULO}Role` },
  { name: 'InstrumentRole',       label: 'Instrument Role',        description: 'The role of a device or instrument used in a clinical process.',                                 mapsToConceptIri: `${SULO}Role` },
  // Value carriers
  { name: 'MeasurementValue',     label: 'Measurement Value',      description: 'A numerical or categorical value obtained from a measurement.',                                   mapsToConceptIri: `${SULO}Quantity` },
  { name: 'Unit',                 label: 'Unit',                   description: 'A unit of measure associated with a measurement or dose.',                                        mapsToConceptIri: `${SULO}Quality` },
  { name: 'DoseQuantity',         label: 'Dose Quantity',          description: 'The quantity of a drug dispensed or administered.',                                               mapsToConceptIri: `${SULO}Quantity` },
  // Added to mirror PMC12935678's FHIR<->OMOP Observation/Measurement crosswalk
  { name: 'MeasurementEvent',     label: 'Measurement Event',      description: 'Groups two or more Measurement rows that jointly report one composite reading (e.g. systolic+diastolic blood pressure).', mapsToConceptIri: `${SULO}Process` },
];

const FHIR_EXAMPLE_CLASSES: { name: string; label: string; description: string; mapsToConceptIri?: string; superClassName?: string }[] = [
  { name: 'Code',                       label: 'Code',                        description: 'A coded value with its identifier, coding system/version, and display name.',      mapsToConceptIri: `${SULO}InformationObject` },
  { name: 'Patient',                    label: 'Patient',                     description: 'The subject of care a clinical resource is about.',                                mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'Encounter',                  label: 'Encounter',                   description: 'A healthcare encounter between a patient and the healthcare system.',               mapsToConceptIri: `${SULO}Process` },
  { name: 'Status',                     label: 'Status',                      description: 'The categorical status of a clinical resource (e.g. active, completed, stopped).', mapsToConceptIri: `${SULO}Quality` },
  { name: 'Route',                      label: 'Route',                       description: 'The categorical route of administration of a medication (e.g. oral, intravenous).', mapsToConceptIri: `${SULO}Quality` },
  { name: 'Frequency',                  label: 'Frequency',                   description: 'The categorical dosing frequency of a medication.',                                mapsToConceptIri: `${SULO}Quality` },
  { name: 'ResultInterpretation',       label: 'Result Interpretation',       description: 'The categorical clinical interpretation of a lab result (e.g. high, low, normal, abnormal).', mapsToConceptIri: `${SULO}Quality` },
  { name: 'SubjectOfCareRole',          label: 'Subject of Care Role',        description: 'The role played by a patient as the subject of a clinical event.',                 mapsToConceptIri: SHARED_ROLES.subjectOfCare },
  { name: 'Dose',                       label: 'Dose',                        description: 'The quantity of a medication administered, dispensed, or requested.',              mapsToConceptIri: `${SULO}Quantity` },
  { name: 'Specimen',                   label: 'Specimen',                    description: 'A biological specimen collected from a patient for laboratory analysis.',          mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'Condition',                  label: 'Condition',                   description: 'A clinical condition, problem, or diagnosis recorded for a patient.',              mapsToConceptIri: `${SULO}Process` },
  { name: 'Medication',                 label: 'Medication',                  description: 'A pharmaceutical substance or drug formulation identified by a code.',             mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'MedicationEvent',            label: 'Medication Event',            description: 'The shared parent of a medication request, dispense, or administration event.',    mapsToConceptIri: `${SULO}Process` },
  { name: 'MedicationRequest',          label: 'Medication Request',          description: 'An order or request for a medication.',                                            superClassName: 'MedicationEvent' },
  { name: 'MedicationAdministration',   label: 'Medication Administration',   description: 'An event of a medication actually being administered to a patient.',              superClassName: 'MedicationEvent' },
  { name: 'MedicationDispense',         label: 'Medication Dispense',         description: 'An event of a medication being dispensed to a patient.',                           superClassName: 'MedicationEvent' },
  { name: 'Observation',                label: 'Observation',                 description: 'A clinical fact recorded about a patient (a lab result or a vital sign).',         mapsToConceptIri: `${SULO}Process` },
  { name: 'LabObservation',             label: 'Lab Observation',             description: 'An observation resulting from a laboratory test.',                                 superClassName: 'Observation' },
  { name: 'VitalSignObservation',       label: 'Vital Sign Observation',      description: 'An observation of a vital sign (e.g. heart rate, blood pressure).',                superClassName: 'Observation' },
  // Added to mirror PMC12935678's FHIR<->OMOP Observation/Measurement crosswalk
  { name: 'Practitioner',               label: 'Practitioner',                description: 'A clinician who performed or is otherwise responsible for a clinical observation or event.', mapsToConceptIri: `${SULO}SpatialObject` },
  { name: 'PerformerRole',              label: 'Performer Role',              description: 'The role played by a practitioner as the performer of an observation.',             mapsToConceptIri: SHARED_ROLES.performer },
  { name: 'ObservationComponent',       label: 'Observation Component',       description: 'One component of a composite observation (e.g. the systolic reading within a blood-pressure observation).', mapsToConceptIri: `${SULO}Process` },
  { name: 'Comparator',                 label: 'Comparator',                  description: 'The categorical qualifier on a result value (e.g. less-than, greater-or-equal).', mapsToConceptIri: `${SULO}Quality` },
  { name: 'Category',                   label: 'Category',                    description: 'The categorical classification of an observation (e.g. vital-signs, laboratory).', mapsToConceptIri: `${SULO}Quality` },
];

// ─── List page ────────────────────────────────────────────────────────────────

function SchemaListPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [isCreatingExample, setIsCreatingExample] = useState(false);
  const [isCreatingOmopExample, setIsCreatingOmopExample] = useState(false);
  const [isCreatingFhirExample, setIsCreatingFhirExample] = useState(false);
  const schemasQuery = useOntologySchemas();
  const createMutation = useCreateOntologySchema();
  const deleteMutation = useDeleteOntologySchema();
  const navigate = useNavigate();

  async function handleLoadExample() {
    setIsCreatingExample(true);
    try {
      const schema = await createMutation.mutateAsync({
        title: 'Clinical Health Record Schema',
        description: 'Example schema covering core clinical concepts: visits, lab results, procedures, conditions, severity, treatments, and drugs.',
        upperOntologyIri: 'https://w3id.org/sulo/',
      });

      // Create all classes and index them by name.
      // superClassName is resolved to a live ID at creation time — MedicalProcedure
      // appears earlier in the array so its ID is already in classMap when the three
      // subclasses (MeasurementProcess, EvaluationProcess, MedicationAdministration) are created.
      const classMap = new Map<string, OntologyClass>();
      for (const cls of CLINICAL_EXAMPLE_CLASSES) {
        const { superClassName, ...rest } = cls;
        const superCls = superClassName ? classMap.get(superClassName) : undefined;
        const body = { ...rest, ...(superCls ? { superClassId: superCls.id } : {}) };
        console.log('[example] POST class', cls.name, 'superClassId=', (body as { superClassId?: string }).superClassId ?? '(none)');
        const created: OntologyClass = (await apiClient.post(`/ontology-schemas/${schema.id}/classes`, body)).data;
        console.log('[example] created', cls.name, '→ id=', created.id, 'superClassId=', created.superClassId ?? '(none)');
        classMap.set(cls.name, created);
      }

      // Add properties for ClinicalVisit
      const clinicalVisit       = classMap.get('ClinicalVisit');
      const subjectOfCareRole   = classMap.get('SubjectOfCareRole');
      const careProviderRole    = classMap.get('CareProviderRole');
      const person              = classMap.get('Person');
      const careUnit            = classMap.get('CareUnit');
      const measurementProcess  = classMap.get('MeasurementProcess');
      const outputRole          = classMap.get('OutputRole');
      const measurement         = classMap.get('Measurement');
      const processStatus       = classMap.get('ProcessStatus');
      const instrumentRole      = classMap.get('InstrumentRole');
      const device              = classMap.get('Device');
      const performerRole       = classMap.get('PerformerRole');
      const clinicalCondition   = classMap.get('ClinicalCondition');
      const anatomicalStructure = classMap.get('AnatomicalStructure');
      const severity            = classMap.get('Severity');
      const plan                = classMap.get('CarePlan');
      const evaluationProcess             = classMap.get('EvaluationProcess');
      const medicationAdministration      = classMap.get('MedicationAdministration');
      const pharmaceuticalProduct         = classMap.get('PharmaceuticalProduct');
      const pharmaceuticalDoseForm   = classMap.get('PharmaceuticalDoseForm');
      const diagnosticStatement      = classMap.get('DiagnosticStatement');
      const code                     = classMap.get('Code');
      const observableEntity         = classMap.get('ObservableEntity');
      const sctProcedure             = classMap.get('SCT_Procedure');
      const medicalProcedure    = classMap.get('MedicalProcedure');
      const administrativeCase  = classMap.get('AdministrativeCase');
      const sample              = classMap.get('Sample');
      const substance           = classMap.get('Substance');
      const drugPrescription    = classMap.get('DrugPrescription');

      if (clinicalVisit && subjectOfCareRole && person) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasPatient',
          label:         'Has Patient',
          description:   'Links a clinical visit to the patient (subject of care).',
          propertyType:  'object',
          domainClassId: clinicalVisit.id,
          rangeClassIri: person.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',              object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',   object: subjectOfCareRole.url },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',                 object: '?value' },
          ],
        });
      }

      if (clinicalVisit && careProviderRole && person) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasCareProvider',
          label:         'Has Care Provider',
          description:   'Links a clinical visit to the care provider.',
          propertyType:  'object',
          domainClassId: clinicalVisit.id,
          rangeClassIri: person.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',              object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',   object: careProviderRole.url },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',                 object: '?value' },
          ],
        });
      }

      if (clinicalVisit && careUnit) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasCareUnit',
          label:         'Has Care Unit',
          description:   'Links a clinical visit to the care unit where it takes place.',
          propertyType:  'object',
          domainClassId: clinicalVisit.id,
          rangeClassIri: careUnit.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/isIn', object: '?value' },
          ],
        });
      }

      // ── Shared properties on MedicalProcedure (inherited by subclasses) ───────
      if (medicalProcedure && subjectOfCareRole && person) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasPatient',
          label:         'Has Patient',
          description:   'Links a medical procedure to the patient it is performed on.',
          propertyType:  'object',
          domainClassId: medicalProcedure.id,
          rangeClassIri: person.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: subjectOfCareRole.url },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
          ],
        });
      }

      if (medicalProcedure && performerRole && person) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasPerformer',
          label:         'Has Performer',
          description:   'Links a medical procedure to the person who performed it.',
          propertyType:  'object',
          domainClassId: medicalProcedure.id,
          rangeClassIri: person.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: performerRole.url },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
          ],
        });
      }

      if (medicalProcedure) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasPerformedDate',
          label:         'Has Performed Date',
          description:   'Links a medical procedure to the date and time it was performed.',
          propertyType:  'datatype',
          domainClassId: medicalProcedure.id,
          rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime',
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/TimeInstant' },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
          ],
        });
      }

      if (medicalProcedure && processStatus) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasStatus',
          label:         'Has Status',
          description:   'Links a medical procedure to its current status.',
          propertyType:  'object',
          domainClassId: medicalProcedure.id,
          rangeClassIri: processStatus.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
          ],
        });
      }

      // ── MeasurementProcess-specific properties ────────────────────────────────
      if (measurementProcess && instrumentRole && device) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasDevice',
          label:         'Has Device',
          description:   'Links a measurement process to the device used as an instrument.',
          propertyType:  'object',
          domainClassId: measurementProcess.id,
          rangeClassIri: device.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: instrumentRole.url },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
          ],
        });
      }

      if (measurement) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasMeasuredDate',
          label:         'Has Measured Date',
          description:   'Links a measurement to the date and time it was recorded.',
          propertyType:  'datatype',
          domainClassId: measurement.id,
          rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime',
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/TimeInstant' },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
          ],
        });
      }

      if (measurement) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasUnit',
          label:         'Has Unit',
          description:   'Links a measurement to its unit of measure.',
          propertyType:  'object',
          domainClassId: measurement.id,
          rangeClassIri: 'https://w3id.org/sulo/Unit',
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasPart', object: '?value' },
          ],
        });
      }

      if (measurement) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasQuantityValue',
          label:         'Has Quantity Value',
          description:   'Links a measurement to its numeric quantity value.',
          propertyType:  'datatype',
          domainClassId: measurement.id,
          rangeClassIri: 'http://www.w3.org/2001/XMLSchema#float',
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
          ],
        });
      }

      if (measurementProcess && outputRole && measurement) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasResult',
          label:         'Has Result',
          description:   'Links a measurement process to its result via an output role.',
          propertyType:  'object',
          domainClassId: measurementProcess.id,
          rangeClassIri: measurement.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: outputRole.url },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
          ],
        });
      }

      if (clinicalCondition) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasRecordDate',
          label:         'Has Record Date',
          description:   'Links a clinical condition to the date and time it was recorded.',
          propertyType:  'datatype',
          domainClassId: clinicalCondition.id,
          rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime',
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/TimeInstant' },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
          ],
        });
      }

      if (clinicalCondition) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasConditionEndDate',
          label:         'Has Condition End Date',
          description:   'Links a clinical condition to the date and time it ended.',
          propertyType:  'datatype',
          domainClassId: clinicalCondition.id,
          rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime',
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/EndTime' },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
          ],
        });
      }

      if (clinicalCondition && anatomicalStructure) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasLocatedIn',
          label:         'Has Located In',
          description:   'Links a clinical condition to the anatomical structure where it is located.',
          propertyType:  'object',
          domainClassId: clinicalCondition.id,
          rangeClassIri: anatomicalStructure.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/isIn', object: '?value' },
          ],
        });
      }

      if (clinicalCondition && severity) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasSeverity',
          label:         'Has Severity',
          description:   'Links a clinical condition to its severity.',
          propertyType:  'object',
          domainClassId: clinicalCondition.id,
          rangeClassIri: severity.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
          ],
        });
      }

      if (plan && medicalProcedure) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasMedicalProcedure',
          label:         'Has Medical Procedure',
          description:   'Links a plan to the medical procedure it refers to.',
          propertyType:  'object',
          domainClassId: plan.id,
          rangeClassIri: medicalProcedure.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/refersTo', object: '?value' },
          ],
        });
      }

      // ── EvaluationProcess-specific properties ─────────────────────────────────
      if (evaluationProcess && outputRole && diagnosticStatement) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasObservation',
          label:         'Has Observation',
          description:   'Links an evaluation process to the diagnostic statement produced as its output.',
          propertyType:  'object',
          domainClassId: evaluationProcess.id,
          rangeClassIri: diagnosticStatement.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: outputRole.url },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
          ],
        });
      }

      // ── PharmaceuticalProduct properties ──────────────────────────────────────
      if (pharmaceuticalProduct) {
        const pharmaceuticalDose = classMap.get('PharmaceuticalDose');
        if (pharmaceuticalDose) {
          await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
            name:          'hasDoseQuantity',
            label:         'Has Dose Quantity',
            description:   'Links a pharmaceutical product to its dose quantity.',
            propertyType:  'object',
            domainClassId: pharmaceuticalProduct.id,
            rangeClassIri: pharmaceuticalDose.url,
            isRequired:    false,
            mappingPattern: [
              { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
            ],
          });
        }
      }

      if (pharmaceuticalProduct && pharmaceuticalDoseForm) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasDoseForm',
          label:         'Has Dose Form',
          description:   'Links a pharmaceutical product to its dose form.',
          propertyType:  'object',
          domainClassId: pharmaceuticalProduct.id,
          rangeClassIri: pharmaceuticalDoseForm.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
          ],
        });
      }

      // ── MedicationAdministration-specific properties ──────────────────────────
      if (medicationAdministration && pharmaceuticalProduct) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasPharmaceuticalProduct',
          label:         'Has Pharmaceutical Product',
          description:   'Links a medication administration to the pharmaceutical product being administered.',
          propertyType:  'object',
          domainClassId: medicationAdministration.id,
          rangeClassIri: pharmaceuticalProduct.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant', object: '?value' },
          ],
        });
      }

      // ── Code class properties (AIDAVA pattern) ───────────────────────────────
      if (code) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasIdentifier',
          label:         'Has Identifier',
          description:   'The code string itself (e.g. "73211009" for SNOMED CT, "J18.9" for ICD-10).',
          propertyType:  'datatype',
          domainClassId: code.id,
          rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string',
          isRequired:    true,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
          ],
        });
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasCodingSystemAndVersion',
          label:         'Has Coding System And Version',
          description:   'Name and version of the coding system (e.g. "SNOMED CT 2024-03", "ICD-10-CM 2024", "LOINC 2.76").',
          propertyType:  'datatype',
          domainClassId: code.id,
          rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string',
          isRequired:    true,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasLabel', object: '?value' },
          ],
        });
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasName',
          label:         'Has Name',
          description:   'Human-readable display name for the code (e.g. "Pneumonia, unspecified organism").',
          propertyType:  'datatype',
          domainClassId: code.id,
          rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string',
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasLabel', object: '?value' },
          ],
        });
      }

      // ── hasCode links from clinical classes → Code ────────────────────────────
      for (const [domainClass, domainLabel] of [
        [clinicalCondition,        'Clinical Condition'],
        [clinicalVisit,            'Clinical Visit'],
        [medicalProcedure,         'Medical Procedure'],
        [measurement,              'Measurement'],
        [medicationAdministration, 'Medication Administration'],
        [anatomicalStructure,      'Anatomical Structure'],
        [severity,                 'Severity'],
        [pharmaceuticalProduct,    'Pharmaceutical Product'],
      ] as const) {
        if (domainClass && code) {
          await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
            name:          'hasCode',
            label:         'Has Code',
            description:   `Links a ${domainLabel} instance to its terminology code (SNOMED CT, ICD-10, LOINC, ATC, etc.).`,
            propertyType:  'object',
            domainClassId: domainClass.id,
            rangeClassIri: code.url,
            isRequired:    false,
            mappingPattern: [
              { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
            ],
          });
        }
      }

      // ── MedicalProcedure hasCode → SCT_Procedure ─────────────────────────────
      if (medicalProcedure && sctProcedure) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasCode',
          label:         'Has Code',
          description:   'Links a MedicalProcedure to its SNOMED CT procedure code.',
          propertyType:  'object',
          domainClassId: medicalProcedure.id,
          rangeClassIri: sctProcedure.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
          ],
        });
      }

      // ── Measurement hasCode → ObservableEntity (additional range) ───────────
      if (measurement && observableEntity) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name:          'hasCode',
          label:         'Has Code',
          description:   'Links a Measurement to its SNOMED CT observable entity code (e.g. body weight, blood pressure).',
          propertyType:  'object',
          domainClassId: measurement.id,
          rangeClassIri: observableEntity.url,
          isRequired:    false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
          ],
        });
      }

      // ── Properties for the SPHN-adopted classes ──────────────────────────────
      // A clinical visit is part of the administrative case grouping it.
      if (clinicalVisit && administrativeCase) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name: 'hasAdministrativeCase', label: 'Has Administrative Case',
          description: 'Links a clinical visit to the administrative case it belongs to.',
          propertyType: 'object', domainClassId: clinicalVisit.id, rangeClassIri: administrativeCase.url, isRequired: false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: '?value' },
          ],
        });
      }
      // The administrative case has the patient as a participant (subject-of-care role).
      if (administrativeCase && subjectOfCareRole && person) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name: 'hasPatient', label: 'Has Patient',
          description: 'Links an administrative case to the patient it concerns.',
          propertyType: 'object', domainClassId: administrativeCase.id, rangeClassIri: person.url, isRequired: false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
            { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: subjectOfCareRole.url },
            { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
          ],
        });
      }
      // A measurement process is performed on a sample (a participant).
      if (measurementProcess && sample) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name: 'hasSample', label: 'Has Sample',
          description: 'Links a measurement process to the sample it is performed on.',
          propertyType: 'object', domainClassId: measurementProcess.id, rangeClassIri: sample.url, isRequired: false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant', object: '?value' },
          ],
        });
      }
      // A sample is physically part of the patient it was collected from.
      if (sample && person) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name: 'collectedFrom', label: 'Collected From',
          description: 'Links a sample to the patient it was collected from.',
          propertyType: 'object', domainClassId: sample.id, rangeClassIri: person.url, isRequired: false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: '?value' },
          ],
        });
      }
      // A pharmaceutical product has an active substance as a part.
      if (pharmaceuticalProduct && substance) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name: 'hasSubstance', label: 'Has Substance',
          description: 'Links a pharmaceutical product to its active substance.',
          propertyType: 'object', domainClassId: pharmaceuticalProduct.id, rangeClassIri: substance.url, isRequired: false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasPart', object: '?value' },
          ],
        });
      }
      // A drug prescription refers to the prescribed product …
      if (drugPrescription && pharmaceuticalProduct) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name: 'prescribesDrug', label: 'Prescribes Drug',
          description: 'Links a drug prescription to the pharmaceutical product it prescribes.',
          propertyType: 'object', domainClassId: drugPrescription.id, rangeClassIri: pharmaceuticalProduct.url, isRequired: false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/refersTo', object: '?value' },
          ],
        });
      }
      // … and is a feature of the patient it is written for.
      if (drugPrescription && person) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name: 'hasSubject', label: 'Has Subject',
          description: 'Records that the drug prescription (an information object) is about its patient.',
          propertyType: 'object', domainClassId: drugPrescription.id, rangeClassIri: person.url, isRequired: false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/isFeatureOf', object: '?value' },
          ],
        });
      }

      // Debug: fetch the schema back and log superClassId for all classes
      const fetchedSchema = await apiClient.get(`/ontology-schemas/${schema.id}`).then((r) => r.data as { classes: OntologyClass[] });
      console.log('[example] fetched schema classes with superClassId:');
      for (const c of fetchedSchema.classes) {
        if (c.superClassId) console.log(`  ${c.name} → superClassId=${c.superClassId}`);
      }

      navigate(`/ontology/${schema.id}`);
    } finally {
      setIsCreatingExample(false);
    }
  }

  async function handleLoadOmopExample() {
    setIsCreatingOmopExample(true);
    try {
      const schema = await createMutation.mutateAsync({
        title: 'OMOP CDM Schema',
        description: 'OMOP Common Data Model schema with core clinical tables (VisitOccurrence, ConditionOccurrence, DrugExposure, Measurement, ProcedureOccurrence, Observation, DeviceExposure) mapped to SULO.',
        upperOntologyIri: 'https://w3id.org/sulo/',
      });

      // Create all 20 OMOP classes
      const classMap = new Map<string, OntologyClass>();
      for (const cls of OMOP_EXAMPLE_CLASSES) {
        const { superClassName, ...rest } = cls;
        const superCls = superClassName ? classMap.get(superClassName) : undefined;
        const body = { ...rest, ...(superCls ? { superClassId: superCls.id } : {}) };
        const created: OntologyClass = (await apiClient.post(`/ontology-schemas/${schema.id}/classes`, body)).data;
        classMap.set(cls.name, created);
      }

      const visitOccurrence     = classMap.get('VisitOccurrence')!;
      const conditionOccurrence = classMap.get('ConditionOccurrence')!;
      const drugExposure        = classMap.get('DrugExposure')!;
      const measurement         = classMap.get('Measurement')!;
      const procedureOccurrence = classMap.get('ProcedureOccurrence')!;
      const observation         = classMap.get('Observation')!;
      const deviceExposure      = classMap.get('DeviceExposure')!;
      const person              = classMap.get('Person')!;
      const provider            = classMap.get('Provider')!;
      const careSite            = classMap.get('CareSite')!;
      const location            = classMap.get('Location')!;
      const concept             = classMap.get('Concept')!;
      const drugProduct         = classMap.get('DrugProduct')!;
      const device              = classMap.get('Device')!;
      const specimen            = classMap.get('Specimen')!;
      const patientRole         = classMap.get('PatientRole')!;
      const providerRole        = classMap.get('ProviderRole')!;
      const outputRole          = classMap.get('OutputRole')!;
      const instrumentRole      = classMap.get('InstrumentRole')!;
      const measurementValue    = classMap.get('MeasurementValue')!;
      const unit                = classMap.get('Unit')!;
      const doseQuantity        = classMap.get('DoseQuantity')!;
      const measurementEvent    = classMap.get('MeasurementEvent')!;

      // ── Concept properties ────────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'concept_id', label: 'Concept ID',
        description: 'The unique integer identifier of the concept in the vocabulary.',
        propertyType: 'datatype', domainClassId: concept.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#integer', isRequired: true,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'concept_name', label: 'Concept Name',
        description: 'The human-readable name or label of the concept.',
        propertyType: 'datatype', domainClassId: concept.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: true,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasLabel', object: '?value' },
        ],
      });

      // ── VisitOccurrence properties ─────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'person_id', label: 'Person ID',
        description: 'Links a visit occurrence to the patient (subject of care).',
        propertyType: 'object', domainClassId: visitOccurrence.id, rangeClassIri: person.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: patientRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'provider_id', label: 'Provider ID',
        description: 'Links a visit occurrence to the attending healthcare provider.',
        propertyType: 'object', domainClassId: visitOccurrence.id, rangeClassIri: provider.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: providerRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'care_site_id', label: 'Care Site ID',
        description: 'Links a visit occurrence to the care site where it took place.',
        propertyType: 'object', domainClassId: visitOccurrence.id, rangeClassIri: careSite.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isIn', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'visit_concept_id', label: 'Visit Concept ID',
        description: 'Links a visit occurrence to its standardised vocabulary concept (visit type).',
        propertyType: 'object', domainClassId: visitOccurrence.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'visit_start_datetime', label: 'Visit Start Datetime',
        description: 'Date and time when the visit started.',
        propertyType: 'datatype', domainClassId: visitOccurrence.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/StartTime' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'visit_end_datetime', label: 'Visit End Datetime',
        description: 'Date and time when the visit ended.',
        propertyType: 'datatype', domainClassId: visitOccurrence.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/EndTime' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'admitting_source_concept_id', label: 'Admitting Source Concept ID',
        description: 'Concept for the place of service or type of provider from which the patient was admitted.',
        propertyType: 'object', domainClassId: visitOccurrence.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'discharge_to_concept_id', label: 'Discharge To Concept ID',
        description: 'Concept for the place of service or type of provider to which the patient was discharged.',
        propertyType: 'object', domainClassId: visitOccurrence.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'preceding_visit_occurrence_id', label: 'Preceding Visit Occurrence ID',
        description: 'Links a visit to the immediately preceding visit occurrence for the same patient.',
        propertyType: 'object', domainClassId: visitOccurrence.id, rangeClassIri: visitOccurrence.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: '?value' },
        ],
      });

      // ── ConditionOccurrence properties ─────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'person_id', label: 'Person ID',
        description: 'Links a condition occurrence to the patient.',
        propertyType: 'object', domainClassId: conditionOccurrence.id, rangeClassIri: person.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: patientRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'condition_concept_id', label: 'Condition Concept ID',
        description: 'Links a condition occurrence to its standardised diagnosis concept (e.g. SNOMED-CT code).',
        propertyType: 'object', domainClassId: conditionOccurrence.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'visit_occurrence_id', label: 'Visit Occurrence ID',
        description: 'Links a condition occurrence to the enclosing visit occurrence.',
        propertyType: 'object', domainClassId: conditionOccurrence.id, rangeClassIri: visitOccurrence.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'condition_start_datetime', label: 'Condition Start Datetime',
        description: 'Date and time when the condition started.',
        propertyType: 'datatype', domainClassId: conditionOccurrence.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/StartTime' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'condition_end_datetime', label: 'Condition End Datetime',
        description: 'Date and time when the condition ended.',
        propertyType: 'datatype', domainClassId: conditionOccurrence.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/EndTime' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'condition_status_concept_id', label: 'Condition Status Concept ID',
        description: 'Standardised concept reflecting the current status of the condition (e.g. active, inactive, resolved).',
        propertyType: 'object', domainClassId: conditionOccurrence.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'stop_reason', label: 'Stop Reason',
        description: 'The reason the condition was no longer present, as indicated in the source data.',
        propertyType: 'datatype', domainClassId: conditionOccurrence.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });

      // ── DrugExposure properties ────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'person_id', label: 'Person ID',
        description: 'Links a drug exposure to the patient who received the drug.',
        propertyType: 'object', domainClassId: drugExposure.id, rangeClassIri: person.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: patientRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'provider_id', label: 'Provider ID',
        description: 'Links a drug exposure to the prescribing or administering provider.',
        propertyType: 'object', domainClassId: drugExposure.id, rangeClassIri: provider.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: providerRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'drug_concept_id', label: 'Drug Concept ID',
        description: 'Links a drug exposure to the drug concept (RxNorm or ATC code).',
        propertyType: 'object', domainClassId: drugExposure.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/refersTo', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasDrugProduct', label: 'Has Drug Product',
        description: 'Links a drug exposure to the dispensed or administered drug product.',
        propertyType: 'object', domainClassId: drugExposure.id, rangeClassIri: drugProduct.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasDoseQuantity', label: 'Has Dose Quantity',
        description: 'Links a drug exposure to the administered dose quantity.',
        propertyType: 'object', domainClassId: drugExposure.id, rangeClassIri: doseQuantity.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasPart', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'visit_occurrence_id', label: 'Visit Occurrence ID',
        description: 'Links a drug exposure to the enclosing visit occurrence.',
        propertyType: 'object', domainClassId: drugExposure.id, rangeClassIri: visitOccurrence.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'drug_exposure_start_datetime', label: 'Drug Exposure Start Datetime',
        description: 'Date and time when the drug exposure started.',
        propertyType: 'datatype', domainClassId: drugExposure.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/StartTime' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'drug_exposure_end_datetime', label: 'Drug Exposure End Datetime',
        description: 'Date and time when the drug exposure ended.',
        propertyType: 'datatype', domainClassId: drugExposure.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/EndTime' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'stop_reason', label: 'Stop Reason',
        description: 'The reason the drug was discontinued (e.g. regimen completed, side effects, changed).',
        propertyType: 'datatype', domainClassId: drugExposure.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'quantity', label: 'Quantity',
        description: 'The quantity of the drug as recorded in the original prescription or dispensing record.',
        propertyType: 'datatype', domainClassId: drugExposure.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#decimal', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'days_supply', label: 'Days Supply',
        description: 'Number of days of supply as recorded in the original prescription or dispensing record.',
        propertyType: 'datatype', domainClassId: drugExposure.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#integer', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'refills', label: 'Refills',
        description: 'The number of refills after the initial prescription, starting at 0.',
        propertyType: 'datatype', domainClassId: drugExposure.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#integer', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });

      // ── Measurement properties ─────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'person_id', label: 'Person ID',
        description: 'Links a measurement to the patient it was taken from.',
        propertyType: 'object', domainClassId: measurement.id, rangeClassIri: person.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: patientRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'provider_id', label: 'Provider ID',
        description: 'Links a measurement to the provider who ordered or performed it.',
        propertyType: 'object', domainClassId: measurement.id, rangeClassIri: provider.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: providerRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasMeasurementResult', label: 'Has Measurement Result',
        description: 'Links a measurement to its output result value via an output role.',
        propertyType: 'object', domainClassId: measurement.id, rangeClassIri: measurementValue.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: outputRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'measurement_concept_id', label: 'Measurement Concept ID',
        description: 'Links a measurement to its LOINC or SNOMED concept (what was measured).',
        propertyType: 'object', domainClassId: measurement.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'value_as_number', label: 'Value As Number',
        description: 'Numeric result of the measurement.',
        propertyType: 'datatype', domainClassId: measurement.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#float', isRequired: false,
        // Routed through an InformationObject carrier (not the bare hasValue
        // shortcut Measurement's own InformationObject category would allow)
        // so this matches FHIR hasQuantityValue's shape exactly — needed for
        // lossless OMOP<->SULO<->FHIR round-tripping (PMC12935678 crosswalk).
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
          { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/InformationObject' },
          { subject: '?o1', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'unit_concept_id', label: 'Unit Concept ID',
        description: 'Links a measurement to its unit of measure.',
        propertyType: 'object', domainClassId: measurement.id, rangeClassIri: unit.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasPart', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'visit_occurrence_id', label: 'Visit Occurrence ID',
        description: 'Links a measurement to the enclosing visit occurrence.',
        propertyType: 'object', domainClassId: measurement.id, rangeClassIri: visitOccurrence.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'measurement_datetime', label: 'Measurement Datetime',
        description: 'Date and time when the measurement was taken.',
        propertyType: 'datatype', domainClassId: measurement.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/TimeInstant' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'operator_concept_id', label: 'Operator Concept ID',
        description: 'Comparison operator applied to the numeric result (e.g. <, <=, =, >=, >).',
        propertyType: 'object', domainClassId: measurement.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'range_low', label: 'Range Low',
        description: 'Lower bound of the normal reference range for this measurement.',
        propertyType: 'datatype', domainClassId: measurement.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#decimal', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
          { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/InformationObject' },
          { subject: '?o1', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'range_high', label: 'Range High',
        description: 'Upper bound of the normal reference range for this measurement.',
        propertyType: 'datatype', domainClassId: measurement.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#decimal', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
          { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/InformationObject' },
          { subject: '?o1', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });

      // ── ProcedureOccurrence properties ─────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'person_id', label: 'Person ID',
        description: 'Links a procedure occurrence to the patient it was performed on.',
        propertyType: 'object', domainClassId: procedureOccurrence.id, rangeClassIri: person.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: patientRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'provider_id', label: 'Provider ID',
        description: 'Links a procedure occurrence to the provider who performed it.',
        propertyType: 'object', domainClassId: procedureOccurrence.id, rangeClassIri: provider.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: providerRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'procedure_concept_id', label: 'Procedure Concept ID',
        description: 'Links a procedure occurrence to its standardised procedure concept.',
        propertyType: 'object', domainClassId: procedureOccurrence.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'visit_occurrence_id', label: 'Visit Occurrence ID',
        description: 'Links a procedure occurrence to the enclosing visit occurrence.',
        propertyType: 'object', domainClassId: procedureOccurrence.id, rangeClassIri: visitOccurrence.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'procedure_datetime', label: 'Procedure Datetime',
        description: 'Date and time when the procedure was performed.',
        propertyType: 'datatype', domainClassId: procedureOccurrence.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/TimeInstant' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'procedure_end_datetime', label: 'Procedure End Datetime',
        description: 'Date and time when the procedure ended.',
        propertyType: 'datatype', domainClassId: procedureOccurrence.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/EndTime' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });

      // ── Observation properties ─────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'person_id', label: 'Person ID',
        description: 'Links a clinical observation to the patient it concerns.',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: person.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: patientRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'observation_concept_id', label: 'Observation Concept ID',
        description: 'Links an observation to its standardised concept (e.g. smoking status, BMI).',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'value_as_string', label: 'Value As String',
        description: 'Textual or categorical value of the observation.',
        propertyType: 'datatype', domainClassId: observation.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'visit_occurrence_id', label: 'Visit Occurrence ID',
        description: 'Links an observation to the enclosing visit occurrence.',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: visitOccurrence.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'observation_datetime', label: 'Observation Datetime',
        description: 'Date and time of the observation.',
        propertyType: 'datatype', domainClassId: observation.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/TimeInstant' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'value_as_number', label: 'Value As Number',
        description: 'Numeric result when the observation is expressed as a quantitative value.',
        propertyType: 'datatype', domainClassId: observation.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#decimal', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'value_as_concept_id', label: 'Value As Concept ID',
        description: 'Categorical result when the observation is expressed as a standardised concept.',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'unit_concept_id', label: 'Unit Concept ID',
        description: 'Links an observation to its unit of measure (for numeric observations).',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: unit.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasPart', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'qualifier_concept_id', label: 'Qualifier Concept ID',
        description: 'Qualifier concept characterising the observation (e.g. severity, certainty, laterality).',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'provider_id', label: 'Provider ID',
        description: 'Links an observation to the provider responsible for documenting it.',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: provider.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: providerRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });

      // ── DeviceExposure properties ──────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'person_id', label: 'Person ID',
        description: 'Links a device exposure to the patient.',
        propertyType: 'object', domainClassId: deviceExposure.id, rangeClassIri: person.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: patientRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'provider_id', label: 'Provider ID',
        description: 'Links a device exposure to the provider who applied the device.',
        propertyType: 'object', domainClassId: deviceExposure.id, rangeClassIri: provider.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: providerRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'device_concept_id', label: 'Device Concept ID',
        description: 'Links a device exposure to its standardised device concept.',
        propertyType: 'object', domainClassId: deviceExposure.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasDevice', label: 'Has Device',
        description: 'Links a device exposure to the physical device via an instrument role.',
        propertyType: 'object', domainClassId: deviceExposure.id, rangeClassIri: device.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: instrumentRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'visit_occurrence_id', label: 'Visit Occurrence ID',
        description: 'Links a device exposure to the enclosing visit occurrence.',
        propertyType: 'object', domainClassId: deviceExposure.id, rangeClassIri: visitOccurrence.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'device_exposure_start_datetime', label: 'Device Exposure Start Datetime',
        description: 'Date and time when the device exposure started.',
        propertyType: 'datatype', domainClassId: deviceExposure.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/StartTime' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'device_exposure_end_datetime', label: 'Device Exposure End Datetime',
        description: 'Date and time when the device exposure ended.',
        propertyType: 'datatype', domainClassId: deviceExposure.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/EndTime' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });

      // ── #1: *_type_concept_id on all 7 core event tables + Specimen ──────────
      for (const [domainClass, propName, tableLabel] of [
        [visitOccurrence,     'visit_type_concept_id',        'visit'],
        [conditionOccurrence, 'condition_type_concept_id',    'condition'],
        [drugExposure,        'drug_type_concept_id',         'drug exposure'],
        [measurement,         'measurement_type_concept_id',  'measurement'],
        [procedureOccurrence, 'procedure_type_concept_id',    'procedure'],
        [observation,         'observation_type_concept_id',  'observation'],
        [deviceExposure,      'device_type_concept_id',       'device exposure'],
        [specimen,            'specimen_type_concept_id',     'specimen'],
      ] as const) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name: propName, label: 'Type Concept ID',
          description: `Provenance concept reflecting the source and origin of the ${tableLabel} record (e.g. EHR entry, claim, lab result).`,
          propertyType: 'object', domainClassId: domainClass.id, rangeClassIri: concept.url, isRequired: true,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
          ],
        });
      }

      // ── #4: *_source_concept_id on all 7 core event tables ───────────────────
      for (const [domainClass, propName, tableLabel] of [
        [visitOccurrence,     'visit_source_concept_id',        'visit'],
        [conditionOccurrence, 'condition_source_concept_id',    'condition'],
        [drugExposure,        'drug_source_concept_id',         'drug exposure'],
        [measurement,         'measurement_source_concept_id',  'measurement'],
        [procedureOccurrence, 'procedure_source_concept_id',    'procedure'],
        [observation,         'observation_source_concept_id',  'observation'],
        [deviceExposure,      'device_source_concept_id',       'device exposure'],
      ] as const) {
        await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
          name: propName, label: 'Source Concept ID',
          description: `Links a ${tableLabel} to the original source vocabulary concept before mapping to a standard concept.`,
          propertyType: 'object', domainClassId: domainClass.id, rangeClassIri: concept.url, isRequired: false,
          mappingPattern: [
            { subject: '?this', predicate: 'https://w3id.org/sulo/refersTo', object: '?value' },
          ],
        });
      }

      // ── #5: valueAsConcept on Measurement ─────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'value_as_concept_id', label: 'Value As Concept ID',
        description: 'Categorical result of the measurement expressed as a standardised concept (e.g. Positive, Negative, Present).',
        propertyType: 'object', domainClassId: measurement.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });

      // ── #7: hasRouteConcept on DrugExposure ───────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'route_concept_id', label: 'Route Concept ID',
        description: 'Links a drug exposure to the route of administration concept (e.g. oral, intravenous, topical).',
        propertyType: 'object', domainClassId: drugExposure.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });

      // ── #10: Location class + CareSite.hasLocation ────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'location_id', label: 'Location ID',
        description: 'Links a care site to its physical or geographic location.',
        propertyType: 'object', domainClassId: careSite.id, rangeClassIri: location.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isIn', object: '?value' },
        ],
      });

      // ── #11: Specimen properties ───────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'person_id', label: 'Person ID',
        description: 'Links a specimen to the person it was collected from.',
        propertyType: 'object', domainClassId: specimen.id, rangeClassIri: person.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant',            object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: patientRole.url },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/isFeatureOf',               object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'specimen_concept_id', label: 'Specimen Concept ID',
        description: 'Links a specimen to its standardised type concept (e.g. blood, urine, tissue).',
        propertyType: 'object', domainClassId: specimen.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'anatomic_site_concept_id', label: 'Anatomic Site Concept ID',
        description: 'Links a specimen to the anatomical site from which it was collected.',
        propertyType: 'object', domainClassId: specimen.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isIn', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'specimen_datetime', label: 'Specimen Datetime',
        description: 'Date and time when the specimen was collected.',
        propertyType: 'datatype', domainClassId: specimen.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime',                    object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/TimeInstant' },
          { subject: '?o1',   predicate: 'https://w3id.org/sulo/hasValue',                  object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'specimen_source_concept_id', label: 'Specimen Source Concept ID',
        description: 'Links a specimen to its original source vocabulary concept before mapping.',
        propertyType: 'object', domainClassId: specimen.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/refersTo', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'quantity', label: 'Quantity',
        description: 'The volume or amount of the specimen collected.',
        propertyType: 'datatype', domainClassId: specimen.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#decimal', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'unit_concept_id', label: 'Unit Concept ID',
        description: 'Links a specimen to the unit of measure for its collected quantity.',
        propertyType: 'object', domainClassId: specimen.id, rangeClassIri: unit.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasPart', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'disease_status_concept_id', label: 'Disease Status Concept ID',
        description: 'Standardised concept reflecting the disease status of the patient at the time of specimen collection.',
        propertyType: 'object', domainClassId: specimen.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });

      // ── Fields added to mirror PMC12935678's FHIR<->OMOP Observation/Measurement crosswalk ──
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'measurement_id', label: 'Measurement ID',
        description: 'The row-level surrogate identifier of this measurement.',
        propertyType: 'datatype', domainClassId: measurement.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#integer', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
          { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/InformationObject' },
          { subject: '?o1', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'measurement_date', label: 'Measurement Date',
        description: 'The date (without time) the measurement was taken.',
        propertyType: 'datatype', domainClassId: measurement.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#date', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime', object: '?o1' },
          { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/TimeInstant' },
          { subject: '?o1', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'measurement_time', label: 'Measurement Time',
        description: 'The time-of-day component of the measurement, stored separately from the date.',
        propertyType: 'datatype', domainClassId: measurement.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#time', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/atTime', object: '?o1' },
          { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/TimeInstant' },
          { subject: '?o1', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'measurement_source_value', label: 'Measurement Source Value',
        description: 'The raw, unmapped source string for the measurement concept, as it appeared in the source data.',
        propertyType: 'datatype', domainClassId: measurement.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
          { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/InformationObject' },
          { subject: '?o1', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'value_source_value', label: 'Value Source Value',
        description: 'The raw, unmapped source string for the result value, as it appeared in the source data.',
        propertyType: 'datatype', domainClassId: measurement.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
          { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/InformationObject' },
          { subject: '?o1', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasMeasurementEvent', label: 'Has Measurement Event',
        description: 'Links this measurement to the composite event it is one component of (e.g. one BP reading occasion).',
        propertyType: 'object', domainClassId: measurement.id, rangeClassIri: measurementEvent.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/isIn', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'race_concept_id', label: 'Race Concept ID',
        description: "Standardised concept reflecting the person's race.",
        propertyType: 'object', domainClassId: person.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'ethnicity_concept_id', label: 'Ethnicity Concept ID',
        description: "Standardised concept reflecting the person's ethnicity.",
        propertyType: 'object', domainClassId: person.id, rangeClassIri: concept.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'person_source_value', label: 'Person Source Value',
        description: 'The raw source-system identifier for this person.',
        propertyType: 'datatype', domainClassId: person.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
          { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/InformationObject' },
          { subject: '?o1', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'visit_occurrence_source_value', label: 'Visit Occurrence Source Value',
        description: 'The raw source-system identifier for this visit.',
        propertyType: 'datatype', domainClassId: visitOccurrence.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
          { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://w3id.org/sulo/InformationObject' },
          { subject: '?o1', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
        ],
      });

      navigate(`/ontology/${schema.id}`);
    } finally {
      setIsCreatingOmopExample(false);
    }
  }

  async function handleLoadFhirExample() {
    setIsCreatingFhirExample(true);
    try {
      const schema = await createMutation.mutateAsync({
        title: 'MIMIC-IV FHIR Demo Schema',
        description: 'Example schema mapping the Observation, Condition, and Medication resources of the MIMIC-IV Clinical Database Demo on FHIR (PhysioNet, kind-lab/mimic-fhir) to SULO.',
        upperOntologyIri: 'https://w3id.org/sulo/',
      });

      // Create all 19 FHIR classes and index them by name.
      // Subclasses (MedicationRequest/Administration/Dispense, LabObservation,
      // VitalSignObservation) appear after their parent so superClassName
      // resolves to a live ID at creation time.
      const classMap = new Map<string, OntologyClass>();
      for (const cls of FHIR_EXAMPLE_CLASSES) {
        const { superClassName, ...rest } = cls;
        const superCls = superClassName ? classMap.get(superClassName) : undefined;
        const body = { ...rest, ...(superCls ? { superClassId: superCls.id } : {}) };
        const created: OntologyClass = (await apiClient.post(`/ontology-schemas/${schema.id}/classes`, body)).data;
        classMap.set(cls.name, created);
      }

      const code                     = classMap.get('Code')!;
      const patient                  = classMap.get('Patient')!;
      const encounter                = classMap.get('Encounter')!;
      const status                   = classMap.get('Status')!;
      const route                    = classMap.get('Route')!;
      const frequency                = classMap.get('Frequency')!;
      const resultInterpretation     = classMap.get('ResultInterpretation')!;
      const dose                     = classMap.get('Dose')!;
      const specimen                 = classMap.get('Specimen')!;
      const condition                = classMap.get('Condition')!;
      const medication               = classMap.get('Medication')!;
      const medicationEvent          = classMap.get('MedicationEvent')!;
      const medicationRequest        = classMap.get('MedicationRequest')!;
      const medicationAdministration = classMap.get('MedicationAdministration')!;
      const medicationDispense       = classMap.get('MedicationDispense')!;
      const observation              = classMap.get('Observation')!;
      const labObservation           = classMap.get('LabObservation')!;
      const practitioner             = classMap.get('Practitioner')!;
      const performerRole            = classMap.get('PerformerRole')!;
      const subjectOfCareRole        = classMap.get('SubjectOfCareRole')!;
      const observationComponent     = classMap.get('ObservationComponent')!;
      const comparator               = classMap.get('Comparator')!;
      const category                 = classMap.get('Category')!;

      // Referenced directly (no local class) — matches the SHACL export's
      // `sh:class <https://w3id.org/sulo/Unit>` for hasDoseUnit/hasUnit.
      const externalUnit = `${SULO}Unit`;

      // ── Code properties ───────────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasIdentifier', label: 'Has Identifier',
        description: "The code's identifier value within its coding system.",
        propertyType: 'datatype', domainClassId: code.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: true,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasValue`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasName', label: 'Has Name',
        description: "The code's human-readable display name.",
        propertyType: 'datatype', domainClassId: code.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasLabel`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasCodingSystemAndVersion', label: 'Has Coding System And Version',
        description: 'The coding system and version this code is drawn from (e.g. SNOMED-CT, LOINC).',
        propertyType: 'datatype', domainClassId: code.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: true,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasFeature`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}InformationObject` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });

      // ── Encounter properties ──────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasAdmissionDate', label: 'Has Admission Date',
        description: 'The date and time the patient was admitted for this encounter.',
        propertyType: 'datatype', domainClassId: encounter.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}atTime`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}StartTime` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasDischargeDate', label: 'Has Discharge Date',
        description: 'The date and time the patient was discharged from this encounter.',
        propertyType: 'datatype', domainClassId: encounter.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}atTime`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}EndTime` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasPatient', label: 'Has Patient',
        description: 'Links the encounter to the patient it concerns.',
        propertyType: 'object', domainClassId: encounter.id, rangeClassIri: patient.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasParticipant`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: subjectOfCareRole.url },
          { subject: '?o1',   predicate: `${SULO}isFeatureOf`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasStatus', label: 'Has Status',
        description: "The encounter's status.",
        propertyType: 'object', domainClassId: encounter.id, rangeClassIri: status.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });

      // ── Dose properties ───────────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasDoseAmount', label: 'Has Dose Amount',
        description: 'The numeric amount of the dose.',
        propertyType: 'datatype', domainClassId: dose.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#float', isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasValue`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasDoseUnit', label: 'Has Dose Unit',
        description: 'The unit of measure the dose amount is expressed in.',
        propertyType: 'object', domainClassId: dose.id, rangeClassIri: externalUnit, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasPart`, object: '?value' }],
      });

      // ── Specimen properties ───────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasCode', label: 'Has Code',
        description: 'The type of specimen collected.',
        propertyType: 'object', domainClassId: specimen.id, rangeClassIri: code.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasCollectionDate', label: 'Has Collection Date',
        description: 'The date and time the specimen was collected.',
        propertyType: 'datatype', domainClassId: specimen.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}atTime`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}TimeInstant` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasPatient', label: 'Has Patient',
        description: 'The patient the specimen was collected from.',
        propertyType: 'object', domainClassId: specimen.id, rangeClassIri: patient.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}isPartOf`, object: '?value' }],
      });

      // ── Condition properties ──────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasCode', label: 'Has Code',
        description: 'The coded diagnosis or problem.',
        propertyType: 'object', domainClassId: condition.id, rangeClassIri: code.url, isRequired: true,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasEncounter', label: 'Has Encounter',
        description: 'The encounter this condition was recorded during.',
        propertyType: 'object', domainClassId: condition.id, rangeClassIri: encounter.url, isRequired: true,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}isPartOf`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasPatient', label: 'Has Patient',
        description: 'The patient this condition concerns.',
        propertyType: 'object', domainClassId: condition.id, rangeClassIri: patient.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasParticipant`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: subjectOfCareRole.url },
          { subject: '?o1',   predicate: `${SULO}isFeatureOf`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasRecordedDate', label: 'Has Recorded Date',
        description: 'The date and time the condition was recorded.',
        propertyType: 'datatype', domainClassId: condition.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}atTime`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}TimeInstant` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasSeqNum', label: 'Has Sequence Number',
        description: 'The ranking of the condition relative to other conditions for the same encounter.',
        propertyType: 'datatype', domainClassId: condition.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#integer', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasFeature`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}InformationObject` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });

      // ── Medication properties ─────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasCode', label: 'Has Code',
        description: 'The coded medication substance.',
        propertyType: 'object', domainClassId: medication.id, rangeClassIri: code.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });

      // ── MedicationEvent properties ────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasDoseQuantity', label: 'Has Dose Quantity',
        description: 'The dose administered, dispensed, or requested.',
        propertyType: 'object', domainClassId: medicationEvent.id, rangeClassIri: dose.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasEncounter', label: 'Has Encounter',
        description: 'The encounter this medication event occurred during.',
        propertyType: 'object', domainClassId: medicationEvent.id, rangeClassIri: encounter.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}isPartOf`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasEventDate', label: 'Has Event Date',
        description: 'The date and time of the medication event.',
        propertyType: 'datatype', domainClassId: medicationEvent.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}atTime`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}TimeInstant` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasFrequency', label: 'Has Frequency',
        description: 'The dosing frequency.',
        propertyType: 'object', domainClassId: medicationEvent.id, rangeClassIri: frequency.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasMedication', label: 'Has Medication',
        description: 'The medication substance involved.',
        propertyType: 'object', domainClassId: medicationEvent.id, rangeClassIri: medication.url, isRequired: true,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasParticipant`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasPatient', label: 'Has Patient',
        description: 'The patient this medication event concerns.',
        propertyType: 'object', domainClassId: medicationEvent.id, rangeClassIri: patient.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasParticipant`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: subjectOfCareRole.url },
          { subject: '?o1',   predicate: `${SULO}isFeatureOf`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasRoute', label: 'Has Route',
        description: 'The route of administration.',
        propertyType: 'object', domainClassId: medicationEvent.id, rangeClassIri: route.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasStatus', label: 'Has Status',
        description: "The medication event's status.",
        propertyType: 'object', domainClassId: medicationEvent.id, rangeClassIri: status.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });

      // ── MedicationAdministration / MedicationDispense properties ─────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasRequest', label: 'Has Request',
        description: 'The medication request this administration fulfills.',
        propertyType: 'object', domainClassId: medicationAdministration.id, rangeClassIri: medicationRequest.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}isIn`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasAuthorizingPrescription', label: 'Has Authorizing Prescription',
        description: 'The medication request that authorized this dispense.',
        propertyType: 'object', domainClassId: medicationDispense.id, rangeClassIri: medicationRequest.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}isIn`, object: '?value' }],
      });

      // ── Observation properties ────────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasCode', label: 'Has Code',
        description: 'The coded test or vital sign type this observation is of.',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: code.url, isRequired: true,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasEffectiveDate', label: 'Has Effective Date',
        description: 'The date and time the observation applies to.',
        propertyType: 'datatype', domainClassId: observation.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#dateTime', isRequired: true,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}atTime`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}TimeInstant` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasEncounter', label: 'Has Encounter',
        description: 'The encounter this observation was recorded during.',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: encounter.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}isPartOf`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasPatient', label: 'Has Patient',
        description: 'The patient this observation concerns.',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: patient.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasParticipant`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: subjectOfCareRole.url },
          { subject: '?o1',   predicate: `${SULO}isFeatureOf`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasQuantityValue', label: 'Has Quantity Value',
        description: 'The numeric result value.',
        propertyType: 'datatype', domainClassId: observation.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#float', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasFeature`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}InformationObject` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasStatus', label: 'Has Status',
        description: "The observation's status.",
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: status.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasUnit', label: 'Has Unit',
        description: 'The unit of measure the result value is expressed in.',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: externalUnit, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });

      // ── LabObservation properties ─────────────────────────────────────────────
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasInterpretation', label: 'Has Interpretation',
        description: 'The clinical interpretation of the result.',
        propertyType: 'object', domainClassId: labObservation.id, rangeClassIri: resultInterpretation.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasReferenceRange', label: 'Has Reference Range',
        description: 'The normal reference range for this result, as a display string.',
        propertyType: 'datatype', domainClassId: labObservation.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasFeature`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}InformationObject` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasSpecimen', label: 'Has Specimen',
        description: 'The specimen this lab result was obtained from.',
        propertyType: 'object', domainClassId: labObservation.id, rangeClassIri: specimen.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasParticipant`, object: '?value' }],
      });

      // ── Fields added to mirror PMC12935678's FHIR<->OMOP Observation/Measurement crosswalk ──
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasObservationIdentifier', label: 'Has Identifier',
        description: 'The resource-level identifier of this observation.',
        propertyType: 'datatype', domainClassId: observation.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasFeature`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}InformationObject` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasPerformer', label: 'Has Performer',
        description: 'The practitioner who performed this observation.',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: practitioner.url, isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasParticipant`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: performerRole.url },
          { subject: '?o1',   predicate: `${SULO}isFeatureOf`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasCategory', label: 'Has Category',
        description: 'The categorical classification of this observation (e.g. vital-signs).',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: category.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasComparator', label: 'Has Comparator',
        description: 'The categorical qualifier on the result value (less-than, greater-or-equal, etc).',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: comparator.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasComponent', label: 'Has Component',
        description: 'One component of this composite observation (e.g. the systolic reading within a blood-pressure observation).',
        propertyType: 'object', domainClassId: observation.id, rangeClassIri: observationComponent.url, isRequired: false,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasPart`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasComponentCode', label: 'Has Code',
        description: "This component's own coded type (e.g. LOINC 8480-6 for systolic).",
        propertyType: 'object', domainClassId: observationComponent.id, rangeClassIri: code.url, isRequired: true,
        mappingPattern: [{ subject: '?this', predicate: `${SULO}hasFeature`, object: '?value' }],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasComponentValue', label: 'Has Quantity Value',
        description: "This component's own numeric result value.",
        propertyType: 'datatype', domainClassId: observationComponent.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#float', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasFeature`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}InformationObject` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasReferenceRangeLow', label: 'Has Reference Range Low',
        description: 'The lower bound of the normal reference range, as a number (mirrors OMOP range_low 1:1).',
        propertyType: 'datatype', domainClassId: labObservation.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#decimal', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasFeature`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}InformationObject` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });
      await apiClient.post(`/ontology-schemas/${schema.id}/properties`, {
        name: 'hasReferenceRangeHigh', label: 'Has Reference Range High',
        description: 'The upper bound of the normal reference range, as a number (mirrors OMOP range_high 1:1).',
        propertyType: 'datatype', domainClassId: labObservation.id, rangeClassIri: 'http://www.w3.org/2001/XMLSchema#decimal', isRequired: false,
        mappingPattern: [
          { subject: '?this', predicate: `${SULO}hasFeature`, object: '?o1' },
          { subject: '?o1',   predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SULO}InformationObject` },
          { subject: '?o1',   predicate: `${SULO}hasValue`, object: '?value' },
        ],
      });

      navigate(`/ontology/${schema.id}`);
    } finally {
      setIsCreatingFhirExample(false);
    }
  }

  const form = useForm<NewSchemaForm>({
    resolver: zodResolver(NewSchemaFormSchema),
    defaultValues: { title: '', description: '', upperOntologyIri: '' },
  });

  async function onSubmit(values: NewSchemaForm) {
    const result = await createMutation.mutateAsync({
      title: values.title,
      description: values.description || undefined,
      upperOntologyIri: values.upperOntologyIri || undefined,
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
          <button
            onClick={handleLoadExample}
            disabled={isCreatingExample || isCreatingOmopExample || isCreatingFhirExample}
            className="bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors border border-slate-300"
            title="Create a pre-populated clinical schema with 7 example classes"
          >
            {isCreatingExample ? 'Creating…' : 'Load Example'}
          </button>
          <button
            onClick={handleLoadOmopExample}
            disabled={isCreatingExample || isCreatingOmopExample || isCreatingFhirExample}
            className="bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors border border-slate-300"
            title="Create a pre-populated OMOP CDM schema with 20 classes mapped to SULO"
          >
            {isCreatingOmopExample ? 'Creating…' : 'Load OMOP Example'}
          </button>
          <button
            onClick={handleLoadFhirExample}
            disabled={isCreatingExample || isCreatingOmopExample || isCreatingFhirExample}
            className="bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors border border-slate-300"
            title="Create a pre-populated MIMIC-IV FHIR Demo schema with 19 classes mapped to SULO"
          >
            {isCreatingFhirExample ? 'Creating…' : 'Load FHIR Example'}
          </button>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            + New Schema
          </button>
        </div>
      </div>

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

      {/* Schema list */}
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
            </Link>
            <button
              onClick={() => {
                if (confirm(`Delete "${schema.title}"?`)) deleteMutation.mutate(schema.id);
              }}
              className="text-slate-400 hover:text-red-500 text-sm ml-4 shrink-0 transition-colors"
              title="Delete schema"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {schemasQuery.data?.length === 0 && !showCreate && (
        <div className="text-center py-20 text-slate-400 text-sm">
          No ontology schemas yet.{' '}
          <button onClick={() => setShowCreate(true)} className="text-violet-600 hover:underline">
            Create one
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Detail / Builder page ────────────────────────────────────────────────────

function SchemaDetailPage({ id }: { id: string }) {
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
    defaultValues: { title: '', description: '', upperOntologyIri: '' },
  });

  // Populate meta form when schema loads
  useEffect(() => {
    if (schemaQuery.data) {
      metaForm.reset({
        title: schemaQuery.data.title,
        description: schemaQuery.data.description ?? '',
        upperOntologyIri: schemaQuery.data.upperOntologyIri ?? '',
      });
    }
  }, [schemaQuery.data]);

  const watchPropertyType = propertyForm.watch('propertyType');

  async function onSaveMeta(values: EditSchemaForm) {
    await updateSchema.mutateAsync({
      title: values.title,
      description: values.description || undefined,
      upperOntologyIri: values.upperOntologyIri || undefined,
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
              <button
                onClick={() => setShowConsistency(true)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
              >
                Check consistency
              </button>
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
