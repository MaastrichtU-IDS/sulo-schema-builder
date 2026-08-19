import React, { useState } from 'react';
import { PROPERTY_FEATURE_OWL, PROPERTY_FEATURES_ALL } from '@sulo/schema-core';

// Editor for OWL property characteristics (functional, transitive, …), a single
// inverse property, and a set of disjoint properties. Properties are referenced
// by name; the disjoint box also accepts pasted external IRIs.
export default function PropertyFeaturesEditor({
  propertyType,
  features,
  onChange,
  inverseIri,
  onInverseIriChange,
  disjointPropertyIris,
  onDisjointChange,
  availableProperties = [],
}: {
  propertyType: 'object' | 'datatype';
  features: string[];
  onChange: (v: string[]) => void;
  inverseIri: string;
  onInverseIriChange: (v: string) => void;
  disjointPropertyIris: string[];
  onDisjointChange: (v: string[]) => void;
  availableProperties?: { name: string; url: string }[];
}) {
  const [disjointInput, setDisjointInput] = useState('');

  const visible = PROPERTY_FEATURES_ALL.filter(
    (f) => f.appliesTo === 'both' || propertyType === 'object',
  );

  // Properties are referenced by name: several rows can share a name (e.g. hasCode
  // on multiple domains) but they all collapse to a single OWL property symbol.
  const propertyNames = Array.from(new Set(availableProperties.map((p) => p.name))).sort();

  // Render an OWL reference: a bare schema name → :name, an external IRI → <iri>.
  const owlRef = (v: string) => (/:\/\//.test(v) ? `<${v}>` : `:${v}`);

  function toggle(value: string) {
    onChange(features.includes(value) ? features.filter((f) => f !== value) : [...features, value]);
  }

  function addDisjoint() {
    const v = disjointInput.trim();
    if (v && !disjointPropertyIris.includes(v)) {
      onDisjointChange([...disjointPropertyIris, v]);
    }
    setDisjointInput('');
  }

  function removeDisjoint(v: string) {
    onDisjointChange(disjointPropertyIris.filter((d) => d !== v));
  }

  const unusedNames = propertyNames.filter((n) => !disjointPropertyIris.includes(n));

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-start gap-3">
      <span className="text-xs font-medium text-slate-500 w-28 shrink-0 pt-1">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );

  return (
    <div className="space-y-2.5">

      {/* Characteristics */}
      <Row label="Characteristics">
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {visible.map((f) => (
            <label key={f.value} className="flex items-center gap-1.5 cursor-pointer group">
              <input
                type="checkbox"
                checked={features.includes(f.value)}
                onChange={() => toggle(f.value)}
                className="w-3.5 h-3.5 text-violet-600 rounded border-slate-300 focus:ring-violet-500"
              />
              <span className="text-sm text-slate-700 group-hover:text-violet-700 transition-colors">
                {f.label}
              </span>
              <span className="text-xs text-slate-400 hidden sm:inline">— {f.desc}</span>
            </label>
          ))}
        </div>
      </Row>

      {/* Inverse of — a single property from the schema */}
      {propertyType === 'object' && (
        <Row label="Inverse of">
          <select
            value={inverseIri}
            onChange={(e) => onInverseIriChange(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-2 py-1 text-xs text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 bg-white"
          >
            <option value="">— none —</option>
            {propertyNames.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
            {inverseIri && !propertyNames.includes(inverseIri) && (
              <option value={inverseIri}>{inverseIri.split(/[/#]/).pop()}</option>
            )}
          </select>
        </Row>
      )}

      {/* Disjoint with */}
      <Row label="Disjoint with">
        <div className="space-y-1.5">
          {disjointPropertyIris.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {disjointPropertyIris.map((v) => (
                <span key={v} className="inline-flex items-center gap-1 bg-violet-50 border border-violet-200 text-violet-800 text-xs font-mono rounded px-2 py-0.5">
                  {/:\/\//.test(v) ? v.split(/[/#]/).pop() : v}
                  <button type="button" onClick={() => removeDisjoint(v)} className="text-violet-400 hover:text-violet-600 leading-none ml-0.5">×</button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <select
              value=""
              onChange={(e) => { if (e.target.value) { onDisjointChange([...disjointPropertyIris, e.target.value]); } }}
              className="border border-slate-300 rounded-lg px-2 py-1 text-xs text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 bg-white"
            >
              <option value="">+ from schema…</option>
              {unusedNames.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <input
              type="text"
              value={disjointInput}
              onChange={(e) => setDisjointInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDisjoint(); } }}
              placeholder="or paste IRI + Enter"
              className="flex-1 border border-slate-300 rounded-lg px-2 py-1 text-xs font-mono text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
            />
            <button type="button" onClick={addDisjoint} className="text-xs text-violet-600 hover:text-violet-800 px-2 py-1 border border-violet-200 rounded-lg hover:bg-violet-50 transition-colors">Add</button>
          </div>
        </div>
      </Row>

      {/* OWL preview */}
      {(features.length > 0 || inverseIri || disjointPropertyIris.length > 0) && (
        <Row label="OWL output">
          <p className="text-xs font-mono text-slate-400 bg-slate-50 rounded px-2 py-1 break-all">
            {[
              ...features.map((f) => PROPERTY_FEATURE_OWL[f]).filter(Boolean),
              ...(inverseIri ? [`owl:inverseOf ${owlRef(inverseIri)}`] : []),
              ...disjointPropertyIris.map((v) => `owl:propertyDisjointWith ${owlRef(v)}`),
            ].join(' ;\n  ')}
          </p>
        </Row>
      )}
    </div>
  );
}
