// Generates the OWL the reasoner checks, from the database rather than from
// anything a client sent. Uses @sulo/schema-core — the same generator the
// frontend uses for its downloads — so the verdict shown on a schema page
// describes the schema as stored.
//
// contentHash covers turtleOwl ALONE, deliberately — not shaclTtl, not
// anything else generateExports produces. Spec §3
// (docs/superpowers/specs/2026-08-19-multi-user-backend-design.md) names this:
// "content_hash is the hash of the generated OWL alone, so a mutation that
// produces byte-identical OWL (renaming a label back, re-saving an unchanged
// form) is detected as a no-op and skips the pipeline entirely." A field that
// has no OWL DL entailment (isRequired is the one @sulo/schema-core actually
// has today — it only reaches shaclTtl's sh:minCount) is exactly that no-op
// case, not an exception to it: hashing it in would make every isRequired
// toggle re-run the reasoner for a verdict that cannot have changed.
//
// INVARIANT: `import type` only for kysely here. This module is reachable from
// routes/v1/index.ts, which both storage modes load, and pkg cannot snapshot
// kysely's top-level-await modules — a value import kills the packaged desktop
// binary at startup. See modules/acl/grants.repo.ts for the same note.

import { createHash } from 'node:crypto';
import { generateExports } from '@sulo/schema-core';
import type { OntologySchema, PropertyFeature } from '@sulo/schema-core';
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import * as service from '../schemas/service.js';

export interface GeneratedOwl {
  turtle: string;
  contentHash: string;
}

/**
 * `undefined` for a schema that does not exist — never an empty document.
 * An empty document would hash just as stably as a real one and would cache
 * a "consistent" verdict for a schema the caller mistyped, which is worse
 * than an obvious failure.
 */
export async function generateOwl(db: Kysely<DB>, schemaId: string): Promise<GeneratedOwl | undefined> {
  const schema = await service.schemaForReasoning(db, schemaId);
  if (!schema) return undefined;

  // service.schemaForReasoning's properties type propertyFeatures as
  // `string[]` — the API layer's own, deliberately wide, shape for any row
  // already in the table. @sulo/schema-core's OntologyProperty narrows that
  // to the closed PropertyFeature union. Every value that can reach this
  // column was validated against exactly that union by schemas.ts's
  // PropertyFeatureEnum on write (addProperty/updateProperty), so this is a
  // type-level narrowing of already-guaranteed data, not an unchecked cast.
  const owlSchema: OntologySchema = {
    ...schema,
    properties: schema.properties.map((p) => ({ ...p, propertyFeatures: p.propertyFeatures as PropertyFeature[] })),
  };

  const { turtleOwl } = generateExports(owlSchema);
  return {
    turtle: turtleOwl,
    // sha256 of turtleOwl alone — see the module comment above for why
    // shaclTtl (or anything else generateExports produces) must not be
    // folded in here.
    contentHash: createHash('sha256').update(turtleOwl, 'utf8').digest('hex'),
  };
}
