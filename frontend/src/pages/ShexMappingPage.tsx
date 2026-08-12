import { useState } from 'react';
import { useOntologySchemas } from '../api/ontology.js';
import { useCompareSchemas, useCheckShexTransformability, type ShexPropertyPairResult } from '../api/matching.js';

// ─── Small shared bits ──────────────────────────────────────────────────────

function SchemaSelect({
  label, value, onChange,
}: { label: string; value: string; onChange: (id: string) => void }) {
  const { data: schemas, isLoading } = useOntologySchemas();
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={isLoading}
        className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 bg-white disabled:opacity-50"
      >
        <option value="">Select a schema…</option>
        {schemas?.map((s) => (
          <option key={s.id} value={s.id}>{s.title}</option>
        ))}
      </select>
    </label>
  );
}

function VerdictBadge({ transformable }: { transformable: boolean }) {
  return transformable ? (
    <span className="text-xs font-semibold bg-emerald-100 text-emerald-700 px-2.5 py-1 rounded-full">✓ Transformable</span>
  ) : (
    <span className="text-xs font-semibold bg-red-100 text-red-700 px-2.5 py-1 rounded-full">✗ Not transformable</span>
  );
}

function ErrorList({ verdict }: { verdict: ShexPropertyPairResult['sourceAcceptsTarget'] }) {
  if (verdict.conformant || !verdict.errors) return null;
  const errors = Array.isArray(verdict.errors) ? verdict.errors : [verdict.errors];
  return (
    <ul className="mt-1 space-y-0.5">
      {errors.map((e, i) => (
        <li key={i} className="text-[11px] font-mono text-red-600">
          {(e as { type?: string })?.type ?? 'Error'}
          {(e as { property?: string })?.property ? `: ${(e as { property?: string }).property}` : ''}
        </li>
      ))}
    </ul>
  );
}

function ShexBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="text-[11px] font-mono uppercase tracking-wide text-slate-400 mb-1">{label}</p>
      <pre className="text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre leading-relaxed">{text}</pre>
    </div>
  );
}

function PairCard({ pair }: { pair: ShexPropertyPairResult }) {
  const [expanded, setExpanded] = useState(false);
  const shapeMap = `<urn:shex-sample:target-this>@<${pair.sourceRootLabel}>,<urn:shex-sample:source-this>@<${pair.targetRootLabel}>`;

  return (
    <div className={`border rounded-lg overflow-hidden ${pair.transformable ? 'border-emerald-200' : 'border-red-200'}`}>
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <span className="text-sm font-mono">
          <span className="text-indigo-700">{pair.sourcePropertyName}</span>
          <span className="text-slate-300 mx-2">↔</span>
          <span className="text-emerald-700">{pair.targetPropertyName}</span>
        </span>
        <div className="flex items-center gap-3">
          <VerdictBadge transformable={pair.transformable} />
          <button onClick={() => setExpanded((v) => !v)} className="text-xs text-violet-600 hover:text-violet-800 font-medium">
            {expanded ? '− hide' : '+ show'} ShEx
          </button>
        </div>
      </div>

      {!pair.transformable && (
        <div className="px-4 py-2.5 bg-red-50/50 border-b border-red-100 grid grid-cols-2 gap-4">
          <div>
            <p className="text-[11px] font-medium text-red-700">source-shape rejects target-shaped data</p>
            <ErrorList verdict={pair.sourceAcceptsTarget} />
          </div>
          <div>
            <p className="text-[11px] font-medium text-red-700">target-shape rejects source-shaped data</p>
            <ErrorList verdict={pair.targetAcceptsSource} />
          </div>
        </div>
      )}

      {expanded && (
        <div className="p-4 space-y-3">
          <ShexBlock label={`source ShEx shape (${pair.sourceRootLabel})`} text={pair.sourceShex} />
          <ShexBlock label={`target ShEx shape (${pair.targetRootLabel})`} text={pair.targetShex} />
          <ShexBlock label="ShapeMap (shexSpec/shape-map) — checked in both directions" text={shapeMap} />
          <ShexBlock label="synthetic sample data validated against it" text={pair.sampleData} />
        </div>
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ShexMappingPage() {
  const [sourceSchemaId, setSourceSchemaId] = useState('');
  const [targetSchemaId, setTargetSchemaId] = useState('');

  const compareMutation = useCompareSchemas();
  const shexMutation = useCheckShexTransformability();

  const canCheck = !!sourceSchemaId && !!targetSchemaId && sourceSchemaId !== targetSchemaId;

  async function handleCheck() {
    shexMutation.reset();
    const report = await compareMutation.mutateAsync({ sourceSchemaId, targetSchemaId });
    const pairs = report.matched.flatMap((g) =>
      g.source.flatMap((s) => g.target.map((t) => ({ sourcePropertyId: s.propertyId, targetPropertyId: t.propertyId }))),
    ).slice(0, 50);
    if (pairs.length) {
      shexMutation.mutate({ sourceSchemaId, targetSchemaId, pairs });
    }
  }

  const transformableCount = shexMutation.data?.filter((p) => p.transformable).length ?? 0;

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-3xl font-bold text-slate-800 tracking-tight">ShEx Mapping</h1>
        <p className="text-slate-500 mt-1 max-w-2xl">
          Compiles each schema property's own SULO mapping pattern into a real ShEx (Shape Expressions)
          shape, then checks cross-schema <em>transformability</em> with a ShapeMap
          (<a href="https://github.com/shexSpec/shape-map" target="_blank" rel="noreferrer" className="text-violet-600 hover:underline">shexSpec/shape-map</a>)
          run through the actual <code className="font-mono">shex-validate</code> tool — does synthetic data
          shaped like the target conform to the source's shape, and vice versa? This is a standards-based
          check independent of the shape-key string comparison the Schema Mapping page uses.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SchemaSelect label="Source schema" value={sourceSchemaId} onChange={setSourceSchemaId} />
          <SchemaSelect label="Target schema" value={targetSchemaId} onChange={setTargetSchemaId} />
        </div>
        <p className="text-xs text-slate-400">
          Try the OMOP CDM Schema as source and the MIMIC-IV FHIR Demo Schema as target — every
          shape-matched property pair between them is checked automatically.
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={handleCheck}
            disabled={!canCheck || compareMutation.isPending || shexMutation.isPending}
            className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
          >
            {compareMutation.isPending ? 'Comparing…' : shexMutation.isPending ? 'Validating with shex-validate…' : 'Check ShEx transformability'}
          </button>
          {sourceSchemaId && sourceSchemaId === targetSchemaId && (
            <span className="text-xs text-amber-600">Pick two different schemas.</span>
          )}
        </div>
      </div>

      {(compareMutation.isError || shexMutation.isError) && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-600">
          {((compareMutation.error ?? shexMutation.error) as Error)?.message ?? 'Check failed.'}
        </div>
      )}

      {compareMutation.data && !compareMutation.data.matched.length && (
        <p className="text-sm text-slate-400 italic">No shape-matched property pairs found between these schemas — nothing to check.</p>
      )}

      {shexMutation.data && (
        <div className="space-y-3">
          <div className="flex gap-px bg-slate-200 border border-slate-200 rounded-lg overflow-hidden w-fit">
            <div className="bg-white px-4 py-2.5 min-w-[120px]">
              <div className="text-xl font-semibold text-slate-800 tabular-nums">{transformableCount} / {shexMutation.data.length}</div>
              <div className="text-[11px] text-slate-400 uppercase tracking-wide">transformable pairs</div>
            </div>
          </div>
          {shexMutation.data.map((pair) => (
            <PairCard key={`${pair.sourcePropertyId}-${pair.targetPropertyId}`} pair={pair} />
          ))}
        </div>
      )}
    </div>
  );
}
