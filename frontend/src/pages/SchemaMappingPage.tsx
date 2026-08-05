import { useMemo, useState } from 'react';
import { useOntologySchema, useOntologySchemas } from '../api/ontology.js';
import { useCompareSchemas, useGenerateMappingYaml, type MatchGroup, type MatchReport } from '../api/matching.js';
import MappingBoard from '../components/MappingBoard.js';

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

function ClassFilter({
  schemaId, selected, onChange,
}: { schemaId: string; selected: string[]; onChange: (names: string[]) => void }) {
  const { data: schema } = useOntologySchema(schemaId);
  if (!schemaId) return <div className="text-xs text-slate-400 italic mt-2">Select a schema first.</div>;
  if (!schema) return <div className="text-xs text-slate-400 mt-2">Loading classes…</div>;

  function toggle(name: string) {
    onChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  }

  return (
    <div className="mt-2 border border-slate-200 rounded-lg max-h-48 overflow-y-auto divide-y divide-slate-100">
      {schema.classes.map((c) => (
        <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 cursor-pointer">
          <input
            type="checkbox"
            checked={selected.includes(c.name)}
            onChange={() => toggle(c.name)}
            className="rounded border-slate-300 text-violet-600 focus:ring-violet-500"
          />
          <span className="font-mono text-xs text-slate-700">{c.name}</span>
        </label>
      ))}
    </div>
  );
}

function ShapeBadge({ group }: { group: MatchGroup }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
      <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{group.domainCategory ?? '?'}</span>
      <span className="text-slate-300">::</span>
      <span className="bg-violet-50 text-violet-700 px-2 py-0.5 rounded">{group.shape}</span>
      <span className="text-slate-300">::</span>
      <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{group.rangeCategory ?? '?'}</span>
    </div>
  );
}

function PropChip({ side, p }: { side: 'source' | 'target'; p: MatchGroup['source'][number] }) {
  const color = side === 'source'
    ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
    : 'bg-emerald-50 text-emerald-700 border-emerald-200';
  return (
    <span className={`inline-flex items-center gap-1 border rounded-full px-2.5 py-0.5 text-xs font-mono ${color}`}>
      {p.className}.{p.propertyName}
    </span>
  );
}

// ─── Results ────────────────────────────────────────────────────────────────

function MatchedGroupRow({ group }: { group: MatchGroup }) {
  const ambiguous = group.source.length > 1 || group.target.length > 1;
  return (
    <div className={`rounded-lg border px-4 py-3 ${ambiguous ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <ShapeBadge group={group} />
        {ambiguous && (
          <span className="text-[11px] font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full shrink-0">
            ambiguous — {group.source.length} × {group.target.length} candidates
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        <div className="flex flex-wrap gap-1.5">
          {group.source.map((p) => <PropChip key={p.propertyId} side="source" p={p} />)}
        </div>
        <span className="text-slate-300">→</span>
        <div className="flex flex-wrap gap-1.5">
          {group.target.map((p) => <PropChip key={p.propertyId} side="target" p={p} />)}
        </div>
      </div>
    </div>
  );
}

function OneSidedGroupRow({ group, side }: { group: MatchGroup; side: 'source' | 'target' }) {
  const props = side === 'source' ? group.source : group.target;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <ShapeBadge group={group} />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {props.map((p) => <PropChip key={p.propertyId} side={side} p={p} />)}
      </div>
    </div>
  );
}

function ResultsView({ report }: { report: MatchReport }) {
  const matchedCount = report.matched.reduce((n, g) => n + g.source.length, 0);
  return (
    <div className="space-y-6">
      <div className="flex gap-px bg-slate-200 border border-slate-200 rounded-lg overflow-hidden w-fit">
        {[
          { n: report.matched.length, l: 'matched shapes' },
          { n: matchedCount, l: 'matched properties' },
          { n: report.sourceOnly.reduce((n, g) => n + g.source.length, 0), l: `${report.sourceSchema.title}-only` },
          { n: report.targetOnly.reduce((n, g) => n + g.target.length, 0), l: `${report.targetSchema.title}-only` },
        ].map((s) => (
          <div key={s.l} className="bg-white px-4 py-2.5 min-w-[120px]">
            <div className="text-xl font-semibold text-slate-800 tabular-nums">{s.n}</div>
            <div className="text-[11px] text-slate-400 uppercase tracking-wide">{s.l}</div>
          </div>
        ))}
      </div>

      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">
          Matched — same SULO shape on both sides ({report.sourceSchema.title} ↔ {report.targetSchema.title})
        </h3>
        <div className="space-y-2">
          {report.matched.length === 0 && <p className="text-sm text-slate-400 italic">No shared shapes found.</p>}
          {report.matched.map((g) => <MatchedGroupRow key={g.key} group={g} />)}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{report.sourceSchema.title}-only (no matching shape on the target side)</h3>
        <div className="space-y-2">
          {report.sourceOnly.length === 0 && <p className="text-sm text-slate-400 italic">None.</p>}
          {report.sourceOnly.map((g) => <OneSidedGroupRow key={g.key} group={g} side="source" />)}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{report.targetSchema.title}-only (no matching shape on the source side)</h3>
        <div className="space-y-2">
          {report.targetOnly.length === 0 && <p className="text-sm text-slate-400 italic">None.</p>}
          {report.targetOnly.map((g) => <OneSidedGroupRow key={g.key} group={g} side="target" />)}
        </div>
      </section>
    </div>
  );
}

// ─── YAML panel ─────────────────────────────────────────────────────────────

function YamlPanel({ yaml, filename }: { yaml: string; filename: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(yaml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  function download() {
    const blob = new Blob([yaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
        <span className="text-xs font-mono text-slate-500">{filename}</span>
        <div className="flex gap-2">
          <button onClick={copy} className="text-xs text-slate-600 hover:text-slate-800 border border-slate-200 hover:border-slate-300 bg-white px-3 py-1 rounded-lg transition-colors">
            {copied ? '✓ Copied' : 'Copy'}
          </button>
          <button onClick={download} className="text-xs bg-violet-600 hover:bg-violet-500 text-white px-3 py-1 rounded-lg transition-colors">
            Download
          </button>
        </div>
      </div>
      <pre className="text-xs font-mono text-slate-700 whitespace-pre bg-slate-50 p-4 leading-relaxed max-h-[520px] overflow-auto">
        {yaml}
      </pre>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function SchemaMappingPage() {
  const [sourceSchemaId, setSourceSchemaId] = useState('');
  const [targetSchemaId, setTargetSchemaId] = useState('');
  const [sourceClassNames, setSourceClassNames] = useState<string[]>([]);
  const [targetClassNames, setTargetClassNames] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  const compareMutation = useCompareSchemas();
  const yamlMutation = useGenerateMappingYaml();

  const params = useMemo(() => ({
    sourceSchemaId,
    targetSchemaId,
    sourceClassNames: sourceClassNames.length ? sourceClassNames : undefined,
    targetClassNames: targetClassNames.length ? targetClassNames : undefined,
  }), [sourceSchemaId, targetSchemaId, sourceClassNames, targetClassNames]);

  const canCompare = !!sourceSchemaId && !!targetSchemaId && sourceSchemaId !== targetSchemaId;

  function handleCompare() {
    yamlMutation.reset();
    compareMutation.mutate(params);
  }
  function handleGenerateYaml() {
    yamlMutation.mutate(params);
  }

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-3xl font-bold text-slate-800 tracking-tight">Schema Mapping</h1>
        <p className="text-slate-500 mt-1 max-w-2xl">
          Find SULO-verified structural correspondences between two schemas — a property on each
          side matches only if it shares the identical (domain category, predicate shape, range
          category), the same check used to compare the OMOP CDM and MIMIC-IV FHIR Demo schemas —
          then generate a draft ETL mapping YAML from the result.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SchemaSelect label="Source schema" value={sourceSchemaId} onChange={setSourceSchemaId} />
          <SchemaSelect label="Target schema" value={targetSchemaId} onChange={setTargetSchemaId} />
        </div>

        <button
          onClick={() => setShowFilters((v) => !v)}
          className="text-xs text-violet-600 hover:text-violet-800 font-medium"
        >
          {showFilters ? '− Hide' : '+ Narrow'} class scope (optional — compares all classes if left empty)
        </button>

        {showFilters && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Source classes</span>
              <ClassFilter schemaId={sourceSchemaId} selected={sourceClassNames} onChange={setSourceClassNames} />
            </div>
            <div>
              <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Target classes</span>
              <ClassFilter schemaId={targetSchemaId} selected={targetClassNames} onChange={setTargetClassNames} />
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={handleCompare}
            disabled={!canCompare || compareMutation.isPending}
            className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
          >
            {compareMutation.isPending ? 'Comparing…' : 'Compare'}
          </button>
          {sourceSchemaId && sourceSchemaId === targetSchemaId && (
            <span className="text-xs text-amber-600">Pick two different schemas to compare.</span>
          )}
          {compareMutation.isSuccess && (
            <button
              onClick={handleGenerateYaml}
              disabled={yamlMutation.isPending}
              className="text-sm text-slate-600 hover:text-slate-800 border border-slate-200 hover:border-slate-300 px-5 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              {yamlMutation.isPending ? 'Generating…' : 'Generate draft YAML'}
            </button>
          )}
        </div>
      </div>

      {compareMutation.isError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-600">
          {(compareMutation.error as Error)?.message ?? 'Comparison failed.'}
        </div>
      )}

      {compareMutation.data && <ResultsView report={compareMutation.data} />}

      {compareMutation.data && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          <MappingBoard report={compareMutation.data} />
        </div>
      )}

      {yamlMutation.data && (
        <section>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Draft ETL mapping YAML</h3>
          <p className="text-xs text-slate-400 mb-2 max-w-2xl">
            Compatible with the <code className="font-mono">etl/transforms/ops.py</code> interpreter —
            REVIEW/TODO comments mark what the ontology alone couldn't decide (ambiguous candidates,
            real JSON path names, composite fields). Hand-finish before use, the same way
            <code className="font-mono"> etl/mappings/condition.yaml</code>,
            <code className="font-mono"> observation.yaml</code> and
            <code className="font-mono"> medication.yaml</code> were.
          </p>
          <YamlPanel
            yaml={yamlMutation.data}
            filename={`${compareMutation.data?.sourceSchema.title ?? 'source'}_to_${compareMutation.data?.targetSchema.title ?? 'target'}.yaml`.replace(/\s+/g, '_')}
          />
        </section>
      )}
    </div>
  );
}
