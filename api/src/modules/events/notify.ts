// Announces a schema change over Postgres NOTIFY (spec §8). The payload is a
// HINT ONLY — `{ schemaId, kind, at }`, never a title, a report or an owner
// id — because a NOTIFY is delivered to every listener on the channel in
// this process regardless of who may read the schema it names; the actual
// data only ever reaches a subscriber through the ACL-checked endpoints it
// already uses (GET .../report, GET .../:id, …). That is also what makes
// this safe to extend later: real-time collaboration can replace the hint
// with a CRDT operation without touching the transport or the ACL gate this
// module has nothing to do with.
//
// CHANNEL SHAPE — decided here, not left to whoever writes the listener next
// (plan 5 task 1's own instruction): ONE channel (`schema_changed`) for
// every schema, with the schema id inside the payload, rather than one
// channel per schema (`schema:<uuid>`).
//
//   - Per-schema channels need dynamic LISTEN/UNLISTEN as pages open and
//     close, on a connection that already has to survive reconnects
//     (listener.ts) — that bookkeeping (what is this connection currently
//     listening to, right now, mid-reconnect) is exactly where a leak or a
//     missed subscription hides, and it buys nothing at this deployment's
//     scale.
//   - One channel means the listener LISTENs exactly once, for the
//     process's lifetime, and reconnecting after a dropped connection is
//     "LISTEN to the one channel again" — no per-subscriber state to
//     replay. The cost is that every notification wakes every API process
//     and the in-process fanout (listener.ts) does the filtering by
//     schema id — trivial at a classroom's traffic, and Postgres itself
//     comfortably handles far more NOTIFY volume than this deployment will
//     ever produce.
//
// Given this is a classroom deployment, not a public multi-tenant SaaS, the
// second option is the deliberate choice; the first is the one to revisit if
// this ever needs to scale past what one process's in-process fanout can
// filter through cheaply.
//
// INVARIANT: `import { sql } from 'kysely'` here is a REAL VALUE import —
// `pg_notify` has no first-class Kysely query-builder method, so this module
// cannot keep the `import type`-only discipline every other file reachable
// from routes/v1/index.ts follows. That is fine PRECISELY BECAUSE this
// module must never be statically imported from that graph: schemas/
// service.ts and reasoning/pipeline.ts both call it, and both sit on that
// graph in both storage modes — so each calls this module the same way
// pipeline.ts calls queue.repo.ts, with a dynamic `import()` inside the
// function that needs it, never a top-level `import`. A static import here
// would eagerly evaluate this module (and therefore `kysely`'s `sql` value)
// the moment the process starts, in EITHER storage mode, which is exactly
// what kills the packaged desktop binary at startup.

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';

/** The one channel every API process LISTENs to, for its whole lifetime. */
export const SCHEMA_CHANGED_CHANNEL = 'schema_changed';

/**
 * `mutated`: the schema's stored content or processing status changed
 * (an edit, or a check moving to queued/running). `report`: a check
 * concluded — fresh, superseded-but-recorded, or failed. The distinction is
 * informational only: every subscriber reacts to either by refetching
 * through the ACL-checked endpoint it already polls, never by trusting
 * anything in this payload.
 */
export type NotifyKind = 'mutated' | 'report';

export interface SchemaChangedPayload {
  schemaId: string;
  kind: NotifyKind;
  at: string;
}

/**
 * Fires `pg_notify(channel, payload)` through `trx`, so the NOTIFY commits
 * or rolls back with whatever write it accompanies — Postgres's NOTIFY is
 * itself transactional, which is the entire reason this takes a
 * transaction handle rather than the pool: a mutation that fails must
 * announce nothing.
 *
 * `pg_notify(...)` (a function call with two bound parameters), not a raw
 * `NOTIFY channel, 'payload'` statement — the latter needs the channel name
 * as a literal, so the payload could never be parameterised. A schema id is
 * a uuid and cannot inject, but the next field added to this payload may
 * not be so careful.
 */
export async function notifySchemaChanged(
  trx: Kysely<DB>, schemaId: string, kind: NotifyKind,
): Promise<void> {
  const payload: SchemaChangedPayload = { schemaId, kind, at: new Date().toISOString() };
  const json = JSON.stringify(payload);
  // Postgres's NOTIFY payload cap is 8000 bytes; this one is a few dozen.
  await sql`select pg_notify(${SCHEMA_CHANGED_CHANNEL}, ${json})`.execute(trx);
}
