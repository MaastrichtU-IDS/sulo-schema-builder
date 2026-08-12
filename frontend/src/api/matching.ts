import { useMutation } from '@tanstack/react-query';
import { apiClient } from './client.js';

// ─── Types (mirrors api/src/services/schemaMatching.service.ts) ─────────────

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

export interface CompareParams {
  sourceSchemaId: string;
  targetSchemaId: string;
  sourceClassNames?: string[];
  targetClassNames?: string[];
}

export async function compareSchemas(params: CompareParams): Promise<MatchReport> {
  const { data } = await apiClient.post('/matching/compare', params);
  return data;
}

export async function generateMappingYaml(params: CompareParams): Promise<string> {
  const { data } = await apiClient.post('/matching/generate-yaml', params);
  return data.yaml as string;
}

// ─── Auto-derived SPARQL CONSTRUCT queries (mirrors sparqlConstruct.service.ts) ──

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

export interface ConstructPropertyPair {
  sourcePropertyId: string;
  sourcePropertyName: string;
  targetPropertyId: string;
  targetPropertyName: string;
  transform: ValueTransform | null;
  forwardSourceToSulo: string | null;
  reverseSuloToSource: string | null;
  forwardTargetToSulo: string | null;
  reverseSuloToTarget: string | null;
  bridgeSourceToTarget: string | null;
  bridgeTargetToSource: string | null;
}

export interface ConstructParams {
  sourceSchemaId: string;
  targetSchemaId: string;
  pairs: Array<{ sourcePropertyId: string; targetPropertyId: string; transform?: ValueTransform }>;
}

export async function generateConstructQueries(params: ConstructParams): Promise<ConstructPropertyPair[]> {
  const { data } = await apiClient.post('/matching/construct', params);
  return data.pairs;
}

// ─── ShEx ShapeMap transformability check (mirrors shex.service.ts) ─────────
// Compiles both properties' own mapping patterns into ShEx shapes
// (shexSpec/shex) and checks "transformability" with a real ShapeMap
// (shexSpec/shape-map) run through the actual shex-validate tool — a
// standards-based check independent of this tool's own shape-key comparison.

export interface ShexVerdict {
  conformant: boolean;
  errors?: unknown;
}

export interface ShexPropertyPairResult {
  sourcePropertyId: string;
  sourcePropertyName: string;
  targetPropertyId: string;
  targetPropertyName: string;
  sourceShex: string;
  targetShex: string;
  sourceRootLabel: string;
  targetRootLabel: string;
  sampleData: string;
  sourceAcceptsTarget: ShexVerdict;
  targetAcceptsSource: ShexVerdict;
  transformable: boolean;
}

export interface ShexCheckParams {
  sourceSchemaId: string;
  targetSchemaId: string;
  pairs: Array<{ sourcePropertyId: string; targetPropertyId: string }>;
}

export async function checkShexTransformability(params: ShexCheckParams): Promise<ShexPropertyPairResult[]> {
  const { data } = await apiClient.post('/matching/shex', params);
  return data.pairs;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useCompareSchemas() {
  return useMutation({ mutationFn: compareSchemas });
}

export function useGenerateMappingYaml() {
  return useMutation({ mutationFn: generateMappingYaml });
}

export function useGenerateConstructQueries() {
  return useMutation({ mutationFn: generateConstructQueries });
}

export function useCheckShexTransformability() {
  return useMutation({ mutationFn: checkShexTransformability });
}
