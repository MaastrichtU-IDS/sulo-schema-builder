import { useEffect, useMemo, useState } from 'react';
import type { DescribedProperty, MatchGroup, MatchReport, ValueTransform, XsdCastType } from '../api/matching.js';
import { useGenerateConstructQueries, type ConstructPropertyPair } from '../api/matching.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function flattenProps(groups: MatchGroup[], side: 'source' | 'target'): DescribedProperty[] {
  const seen = new Map<string, DescribedProperty>();
  for (const g of groups) {
    for (const p of g[side]) seen.set(p.propertyId, p);
  }
  return [...seen.values()].sort((a, b) => `${a.className}.${a.propertyName}`.localeCompare(`${b.className}.${b.propertyName}`));
}

interface PairState {
  sourcePropertyId: string;
  transform: ValueTransform;
}

/** Seed initial pairs from /compare's matches: unambiguous groups auto-pair;
 *  ambiguous ones get a first-candidate suggestion, flagged for confirmation. */
function seedPairs(report: MatchReport): { pairs: Record<string, PairState>; suggested: Set<string> } {
  const pairs: Record<string, PairState> = {};
  const suggested = new Set<string>();
  for (const g of report.matched) {
    for (const t of g.target) {
      if (!g.source.length) continue;
      pairs[t.propertyId] = { sourcePropertyId: g.source[0].propertyId, transform: { kind: 'none' } };
      if (g.source.length > 1 || g.target.length > 1) suggested.add(t.propertyId);
    }
  }
  return { pairs, suggested };
}

const DRAG_MIME = 'application/x-sulo-property-id';

// ─── value transforms ───────────────────────────────────────────────────────
// Two shape-matched properties often still disagree on literal form — a plain
// string vs. xsd:dateTime, a vocabulary-prefixed code, mismatched casing.
// Each option compiles to one real SPARQL 1.1 built-in (see
// sparqlConstruct.service.ts's renderTransformExpr) — no bespoke runtime.

const TRANSFORM_OPTIONS: Array<{ value: ValueTransform['kind']; label: string }> = [
  { value: 'none', label: 'No transform (direct)' },
  { value: 'cast', label: 'Cast type…' },
  { value: 'concatPrefix', label: 'Add prefix…' },
  { value: 'concatSuffix', label: 'Add suffix…' },
  { value: 'splitBefore', label: 'Take part before delimiter…' },
  { value: 'splitAfter', label: 'Take part after delimiter…' },
  { value: 'uppercase', label: 'Uppercase' },
  { value: 'lowercase', label: 'Lowercase' },
  { value: 'substring', label: 'Substring…' },
  { value: 'replace', label: 'Find & replace…' },
];

const XSD_CAST_TYPES: XsdCastType[] = ['string', 'integer', 'decimal', 'double', 'float', 'boolean', 'dateTime', 'date'];

function defaultTransformFor(kind: ValueTransform['kind']): ValueTransform {
  switch (kind) {
    case 'cast': return { kind: 'cast', datatype: 'string' };
    case 'concatPrefix': return { kind: 'concatPrefix', text: '' };
    case 'concatSuffix': return { kind: 'concatSuffix', text: '' };
    case 'splitBefore': return { kind: 'splitBefore', delimiter: '' };
    case 'splitAfter': return { kind: 'splitAfter', delimiter: '' };
    case 'substring': return { kind: 'substring', start: 1 };
    case 'replace': return { kind: 'replace', pattern: '', replacement: '' };
    case 'uppercase': return { kind: 'uppercase' };
    case 'lowercase': return { kind: 'lowercase' };
    default: return { kind: 'none' };
  }
}

function describeTransform(t: ValueTransform): string | null {
  switch (t.kind) {
    case 'none': return null;
    case 'cast': return `cast → xsd:${t.datatype}`;
    case 'concatPrefix': return t.text ? `prefix "${t.text}"` : 'add prefix…';
    case 'concatSuffix': return t.text ? `suffix "${t.text}"` : 'add suffix…';
    case 'splitBefore': return t.delimiter ? `before "${t.delimiter}"` : 'split before…';
    case 'splitAfter': return t.delimiter ? `after "${t.delimiter}"` : 'split after…';
    case 'uppercase': return 'UCASE';
    case 'lowercase': return 'LCASE';
    case 'substring': return `substr(${t.start}${t.length != null ? `, ${t.length}` : ''})`;
    case 'replace': return t.pattern ? `replace "${t.pattern}"→"${t.replacement}"` : 'find & replace…';
  }
}

function TransformPicker({ transform, onChange }: { transform: ValueTransform; onChange: (t: ValueTransform) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1">
      <select
        value={transform.kind}
        onChange={(e) => onChange(defaultTransformFor(e.target.value as ValueTransform['kind']))}
        className="text-[11px] border border-slate-200 rounded px-1.5 py-0.5 bg-white text-slate-600"
        aria-label="Transform operation"
      >
        {TRANSFORM_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {transform.kind === 'cast' && (
        <select
          value={transform.datatype}
          onChange={(e) => onChange({ kind: 'cast', datatype: e.target.value as XsdCastType })}
          className="text-[11px] border border-slate-200 rounded px-1.5 py-0.5 bg-white"
          aria-label="Cast datatype"
        >
          {XSD_CAST_TYPES.map((t) => <option key={t} value={t}>xsd:{t}</option>)}
        </select>
      )}
      {(transform.kind === 'concatPrefix' || transform.kind === 'concatSuffix') && (
        <input
          type="text" placeholder="text" value={transform.text}
          onChange={(e) => onChange({ ...transform, text: e.target.value })}
          className="text-[11px] border border-slate-200 rounded px-1.5 py-0.5 w-24"
        />
      )}
      {(transform.kind === 'splitBefore' || transform.kind === 'splitAfter') && (
        <input
          type="text" placeholder="delimiter" value={transform.delimiter}
          onChange={(e) => onChange({ ...transform, delimiter: e.target.value })}
          className="text-[11px] border border-slate-200 rounded px-1.5 py-0.5 w-20"
        />
      )}
      {transform.kind === 'substring' && (
        <>
          <input
            type="number" min={1} placeholder="start" value={transform.start}
            onChange={(e) => onChange({ ...transform, start: Number(e.target.value) || 1 })}
            className="text-[11px] border border-slate-200 rounded px-1.5 py-0.5 w-14"
          />
          <input
            type="number" min={1} placeholder="length (opt.)" value={transform.length ?? ''}
            onChange={(e) => onChange({ ...transform, length: e.target.value ? Number(e.target.value) : undefined })}
            className="text-[11px] border border-slate-200 rounded px-1.5 py-0.5 w-20"
          />
        </>
      )}
      {transform.kind === 'replace' && (
        <>
          <input
            type="text" placeholder="find" value={transform.pattern}
            onChange={(e) => onChange({ ...transform, pattern: e.target.value })}
            className="text-[11px] border border-slate-200 rounded px-1.5 py-0.5 w-20"
          />
          <input
            type="text" placeholder="replace with" value={transform.replacement}
            onChange={(e) => onChange({ ...transform, replacement: e.target.value })}
            className="text-[11px] border border-slate-200 rounded px-1.5 py-0.5 w-24"
          />
        </>
      )}
    </div>
  );
}

// ─── chip / drop-zone primitives ────────────────────────────────────────────

function SourceChip({ prop, usageCount }: { prop: DescribedProperty; usageCount: number }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, prop.propertyId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      title={`${prop.className}.${prop.propertyName} — ${prop.shape}`}
      className="inline-flex items-center gap-1.5 border border-indigo-200 bg-indigo-50 text-indigo-700 rounded-full pl-2.5 pr-2 py-1 text-xs font-mono cursor-grab active:cursor-grabbing select-none hover:border-indigo-400 hover:shadow-sm transition-all"
    >
      {prop.className}.{prop.propertyName}
      {usageCount > 0 && (
        <span className="bg-indigo-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[9px] font-sans font-semibold">
          {usageCount}
        </span>
      )}
    </div>
  );
}

function DropRow({
  target, assignedId, isSuggested, transform, sourceById, onDrop, onClear, onTransformChange,
}: {
  target: DescribedProperty;
  assignedId: string | undefined;
  isSuggested: boolean;
  transform: ValueTransform;
  sourceById: Map<string, DescribedProperty>;
  onDrop: (targetId: string, sourceId: string) => void;
  onClear: (targetId: string) => void;
  onTransformChange: (targetId: string, transform: ValueTransform) => void;
}) {
  const [over, setOver] = useState(false);
  const assigned = assignedId ? sourceById.get(assignedId) : undefined;

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3 px-3 py-2 border-b border-slate-100 last:border-b-0">
      <div>
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const sourceId = e.dataTransfer.getData(DRAG_MIME);
            if (sourceId) onDrop(target.propertyId, sourceId);
          }}
          className={`rounded-lg border-2 border-dashed px-3 py-1.5 min-h-[34px] flex items-center transition-colors ${
            over ? 'border-violet-400 bg-violet-50' : assigned ? 'border-transparent' : 'border-slate-200'
          }`}
        >
          {assigned ? (
            <div className={`inline-flex items-center gap-1.5 border rounded-full pl-2.5 pr-1.5 py-1 text-xs font-mono ${
              isSuggested ? 'border-amber-300 bg-amber-50 text-amber-700 border-dashed' : 'border-indigo-200 bg-indigo-50 text-indigo-700'
            }`}>
              {assigned.className}.{assigned.propertyName}
              <button
                onClick={() => onClear(target.propertyId)}
                className="hover:bg-black/10 rounded-full w-4 h-4 flex items-center justify-center leading-none"
                title="Remove this pairing"
              >
                ×
              </button>
            </div>
          ) : (
            <span className="text-xs text-slate-400 italic">drop a source property here</span>
          )}
        </div>
        {assigned && (
          <TransformPicker transform={transform} onChange={(t) => onTransformChange(target.propertyId, t)} />
        )}
      </div>
      <span className="text-slate-300 mt-1.5">→</span>
      <div className="font-mono text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1 w-fit">
        {target.className}.{target.propertyName}
      </div>
    </div>
  );
}

// ─── query result panel ─────────────────────────────────────────────────────

function QueryBlock({ label, query }: { label: string; query: string | null }) {
  if (!query) return null;
  return (
    <div>
      <p className="text-[11px] font-mono uppercase tracking-wide text-slate-400 mb-1">{label}</p>
      <pre className="text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre leading-relaxed">{query}</pre>
    </div>
  );
}

function PairResultCard({ pair }: { pair: ConstructPropertyPair }) {
  const [showSulo, setShowSulo] = useState(false);
  const transformLabel = pair.transform ? describeTransform(pair.transform) : null;
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <span className="text-sm font-mono flex items-center gap-2">
          <span className="text-indigo-700">{pair.sourcePropertyName}</span>
          {transformLabel && (
            <span className="text-[10px] font-sans font-medium bg-violet-100 text-violet-700 rounded-full px-2 py-0.5">
              {transformLabel}
            </span>
          )}
          <span className="text-slate-300 mx-1">→</span>
          <span className="text-emerald-700">{pair.targetPropertyName}</span>
        </span>
        <button onClick={() => setShowSulo((v) => !v)} className="text-xs text-violet-600 hover:text-violet-800 font-medium">
          {showSulo ? '− hide' : '+ show'} SULO-side derivation
        </button>
      </div>
      <div className="p-4 space-y-3">
        <QueryBlock label="bridge — source → target, direct" query={pair.bridgeSourceToTarget} />
        {showSulo && (
          <>
            <QueryBlock label="forward — source flat → SULO (auto-derived from the source property's own mapping pattern)" query={pair.forwardSourceToSulo} />
            <QueryBlock label="reverse — SULO → target flat (auto-derived from the target property's own mapping pattern)" query={pair.reverseSuloToTarget} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── main board ─────────────────────────────────────────────────────────────

export default function MappingBoard({ report }: { report: MatchReport }) {
  const sourceProps = useMemo(() => flattenProps([...report.matched, ...report.sourceOnly], 'source'), [report]);
  const targetProps = useMemo(() => flattenProps([...report.matched, ...report.targetOnly], 'target'), [report]);
  const sourceById = useMemo(() => new Map(sourceProps.map((p) => [p.propertyId, p])), [sourceProps]);

  const [pairs, setPairs] = useState<Record<string, PairState>>({});
  const [suggested, setSuggested] = useState<Set<string>>(new Set());
  const constructMutation = useGenerateConstructQueries();

  useEffect(() => {
    const seeded = seedPairs(report);
    setPairs(seeded.pairs);
    setSuggested(seeded.suggested);
    constructMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  function handleDrop(targetId: string, sourceId: string) {
    // a new source has a different value shape than the last one — the old
    // transform (if any) was tailored to that shape, so don't carry it over
    setPairs((prev) => ({ ...prev, [targetId]: { sourcePropertyId: sourceId, transform: { kind: 'none' } } }));
    setSuggested((prev) => { const next = new Set(prev); next.delete(targetId); return next; });
  }
  function handleClear(targetId: string) {
    setPairs((prev) => { const next = { ...prev }; delete next[targetId]; return next; });
    setSuggested((prev) => { const next = new Set(prev); next.delete(targetId); return next; });
  }
  function handleTransformChange(targetId: string, transform: ValueTransform) {
    setPairs((prev) => ({ ...prev, [targetId]: { ...prev[targetId], transform } }));
  }

  const usageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of Object.values(pairs)) counts.set(p.sourcePropertyId, (counts.get(p.sourcePropertyId) ?? 0) + 1);
    return counts;
  }, [pairs]);

  const confirmedPairCount = Object.keys(pairs).length;
  const suggestedRemaining = [...suggested].filter((t) => pairs[t]).length;

  function handleGenerate() {
    const body = {
      sourceSchemaId: report.sourceSchema.id,
      targetSchemaId: report.targetSchema.id,
      pairs: Object.entries(pairs).map(([targetPropertyId, p]) => ({
        sourcePropertyId: p.sourcePropertyId,
        targetPropertyId,
        transform: p.transform.kind === 'none' ? undefined : p.transform,
      })),
    };
    constructMutation.mutate(body);
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-700">Interactive mapping board</h3>
        <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">
          Pre-filled from the shape-matched pairs above. Drag a source property chip onto a different
          target row to override it — useful when a match was ambiguous (dashed amber = an unconfirmed
          suggestion) or simply wrong.
        </p>
      </div>

      <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
        <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-2">
          Source properties ({report.sourceSchema.title}) — drag onto a row below
        </p>
        <div className="flex flex-wrap gap-1.5">
          {sourceProps.map((p) => (
            <SourceChip key={p.propertyId} prop={p} usageCount={usageCounts.get(p.propertyId) ?? 0} />
          ))}
        </div>
      </div>

      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        {targetProps.map((t) => (
          <DropRow
            key={t.propertyId}
            target={t}
            assignedId={pairs[t.propertyId]?.sourcePropertyId}
            isSuggested={suggested.has(t.propertyId)}
            transform={pairs[t.propertyId]?.transform ?? { kind: 'none' }}
            sourceById={sourceById}
            onDrop={handleDrop}
            onClear={handleClear}
            onTransformChange={handleTransformChange}
          />
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleGenerate}
          disabled={confirmedPairCount === 0 || constructMutation.isPending}
          className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
        >
          {constructMutation.isPending ? 'Generating…' : `Generate CONSTRUCT queries (${confirmedPairCount} pair${confirmedPairCount === 1 ? '' : 's'})`}
        </button>
        {suggestedRemaining > 0 && (
          <span className="text-xs text-amber-700">{suggestedRemaining} unconfirmed suggestion{suggestedRemaining === 1 ? '' : 's'} (dashed) will be used as-is if not corrected.</span>
        )}
      </div>

      {constructMutation.isError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-600">
          {(constructMutation.error as Error)?.message ?? 'Query generation failed.'}
        </div>
      )}

      {constructMutation.data && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-slate-700">Auto-derived SPARQL CONSTRUCT queries</h4>
          {constructMutation.data.map((pair) => (
            <PairResultCard key={`${pair.sourcePropertyId}-${pair.targetPropertyId}`} pair={pair} />
          ))}
        </div>
      )}
    </div>
  );
}
