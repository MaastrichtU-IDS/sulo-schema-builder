import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { compareSchemas, generateDraftYaml } from '../../services/schemaMatching.service.js';
import { fetchFullSchema } from '../../services/schema.service.js';
import { buildBridgeConstruct, buildForwardConstruct, buildReverseConstruct } from '../../services/sparqlConstruct.service.js';
import type { ValueTransform } from '../../services/sparqlConstruct.service.js';
import { checkShexTransformability, ShexUnavailableError } from '../../services/shex.service.js';

const CompareBody = z.object({
  sourceSchemaId: z.string().min(1),
  targetSchemaId: z.string().min(1),
  sourceClassNames: z.array(z.string()).optional(),
  targetClassNames: z.array(z.string()).optional(),
});

const XSD_CAST_TYPES = ['string', 'integer', 'decimal', 'double', 'float', 'boolean', 'dateTime', 'date'] as const;

const ValueTransformBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('cast'), datatype: z.enum(XSD_CAST_TYPES) }),
  z.object({ kind: z.literal('concatPrefix'), text: z.string() }),
  z.object({ kind: z.literal('concatSuffix'), text: z.string() }),
  z.object({ kind: z.literal('splitBefore'), delimiter: z.string().min(1) }),
  z.object({ kind: z.literal('splitAfter'), delimiter: z.string().min(1) }),
  z.object({ kind: z.literal('uppercase') }),
  z.object({ kind: z.literal('lowercase') }),
  z.object({ kind: z.literal('substring'), start: z.number().int().min(1), length: z.number().int().min(1).optional() }),
  z.object({ kind: z.literal('replace'), pattern: z.string().min(1), replacement: z.string() }),
]);

const ConstructBody = z.object({
  sourceSchemaId: z.string().min(1),
  targetSchemaId: z.string().min(1),
  pairs: z.array(z.object({
    sourcePropertyId: z.string().min(1),
    targetPropertyId: z.string().min(1),
    transform: ValueTransformBody.optional(),
  })).min(1).max(200),
});

const matchingRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /matching/compare — find SULO-shape-matched properties/classes
  // between two schemas: which OMOP-side field corresponds to which
  // FHIR-side field, verified by an identical (domain category, predicate
  // shape, range category) triple, not a name-based guess.
  fastify.post('/compare', async (request, reply) => {
    const body = CompareBody.parse(request.body);
    const report = await compareSchemas(
      fastify,
      body.sourceSchemaId,
      body.targetSchemaId,
      body.sourceClassNames,
      body.targetClassNames,
    );
    if (!report) return reply.notFound('One or both schemas were not found');
    return report;
  });

  // POST /matching/generate-yaml — same comparison, rendered as a draft
  // mappings/*.yaml compatible with the etl/transforms/ops.py interpreter.
  fastify.post('/generate-yaml', async (request, reply) => {
    const body = CompareBody.parse(request.body);
    const report = await compareSchemas(
      fastify,
      body.sourceSchemaId,
      body.targetSchemaId,
      body.sourceClassNames,
      body.targetClassNames,
    );
    if (!report) return reply.notFound('One or both schemas were not found');
    return { yaml: generateDraftYaml(report) };
  });

  // POST /matching/construct — auto-derive executable SPARQL CONSTRUCT
  // queries for a set of user-confirmed property pairs (typically produced
  // by dragging a source property onto a target property in the mapping
  // board UI, seeded from /compare's matches). No new specification format:
  // each property's forward/reverse fold is compiled straight from the
  // mapping pattern already stored on it, and the bridge query composes the
  // two flat vocabularies directly for one confirmed pair.
  fastify.post('/construct', async (request, reply) => {
    const body = ConstructBody.parse(request.body);
    const [sourceSchema, targetSchema] = await Promise.all([
      fetchFullSchema(fastify, body.sourceSchemaId),
      fetchFullSchema(fastify, body.targetSchemaId),
    ]);
    if (!sourceSchema || !targetSchema) return reply.notFound('One or both schemas were not found');

    const pairs = body.pairs
      .map(({ sourcePropertyId, targetPropertyId, transform }) => {
        const sourceProp = sourceSchema.properties.find((p) => p.id === sourcePropertyId);
        const targetProp = targetSchema.properties.find((p) => p.id === targetPropertyId);
        if (!sourceProp || !targetProp) return null;
        return {
          sourcePropertyId: sourceProp.id,
          sourcePropertyName: sourceProp.name,
          targetPropertyId: targetProp.id,
          targetPropertyName: targetProp.name,
          transform: transform ?? null,
          forwardSourceToSulo: buildForwardConstruct(sourceProp, sourceSchema),
          reverseSuloToSource: buildReverseConstruct(sourceProp, sourceSchema),
          forwardTargetToSulo: buildForwardConstruct(targetProp, targetSchema),
          reverseSuloToTarget: buildReverseConstruct(targetProp, targetSchema),
          // the transform is directional (source's raw shape -> target's expected
          // shape) and not generally invertible, so it is applied only forward;
          // the reverse bridge stays a plain passthrough unless the user maps
          // that direction separately.
          bridgeSourceToTarget: buildBridgeConstruct(sourceProp, sourceSchema, targetProp, targetSchema, transform as ValueTransform | undefined),
          bridgeTargetToSource: buildBridgeConstruct(targetProp, targetSchema, sourceProp, sourceSchema),
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    return { pairs };
  });

  // POST /matching/shex — for each confirmed property pair, compile both
  // properties' own mapping patterns into ShEx shapes (shexSpec/shex), and
  // check "transformability" with a real ShapeMap (shexSpec/shape-map) run
  // through the actual `shex-validate` tool: does target-shaped sample data
  // conform to the source's shape, and vice versa? This is independent of
  // (and a stronger check than) this tool's own shape-key string comparison
  // used by /compare — it validates against a standards-based artifact any
  // ShEx-conformant tool could also check.
  const ShexBody = z.object({
    sourceSchemaId: z.string().min(1),
    targetSchemaId: z.string().min(1),
    pairs: z.array(z.object({
      sourcePropertyId: z.string().min(1),
      targetPropertyId: z.string().min(1),
    })).min(1).max(50),
  });

  fastify.post('/shex', async (request, reply) => {
    const body = ShexBody.parse(request.body);
    const [sourceSchema, targetSchema] = await Promise.all([
      fetchFullSchema(fastify, body.sourceSchemaId),
      fetchFullSchema(fastify, body.targetSchemaId),
    ]);
    if (!sourceSchema || !targetSchema) return reply.notFound('One or both schemas were not found');

    try {
      const pairs = await Promise.all(body.pairs.map(async ({ sourcePropertyId, targetPropertyId }) => {
        const sourceProp = sourceSchema.properties.find((p) => p.id === sourcePropertyId);
        const targetProp = targetSchema.properties.find((p) => p.id === targetPropertyId);
        if (!sourceProp || !targetProp) return null;
        const result = await checkShexTransformability(sourceProp, sourceSchema, targetProp, targetSchema);
        if (!result) return null;
        return {
          sourcePropertyId: sourceProp.id,
          sourcePropertyName: sourceProp.name,
          targetPropertyId: targetProp.id,
          targetPropertyName: targetProp.name,
          ...result,
        };
      }));
      return { pairs: pairs.filter((p): p is NonNullable<typeof p> => p !== null) };
    } catch (err) {
      if (err instanceof ShexUnavailableError) {
        return reply.serviceUnavailable(err.message);
      }
      throw err;
    }
  });
};

export default matchingRoutes;
