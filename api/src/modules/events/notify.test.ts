// pg_notify is the one thing this module does, and it has to get two things
// right that nothing else exercises: it must be genuinely transactional (a
// rolled-back write announces nothing), and its payload must never carry
// more than a hint. A raw `pg.PoolClient` LISTENs directly here — the
// process-wide listener (listener.ts) is task 2's own file and gets its own
// suite.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { notifySchemaChanged, SCHEMA_CHANGED_CHANNEL, type SchemaChangedPayload } from './notify.js';

let t: TestDb;
let listener: PoolClient;

/** Collects every notification delivered on SCHEMA_CHANGED_CHANNEL from here on. */
function collectNotifications(): SchemaChangedPayload[] {
  const received: SchemaChangedPayload[] = [];
  listener.on('notification', (msg) => {
    if (msg.channel === SCHEMA_CHANGED_CHANNEL && msg.payload) {
      received.push(JSON.parse(msg.payload));
    }
  });
  return received;
}

function waitFor(count: number, received: unknown[], timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (received.length >= count) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${count} notification(s), got ${received.length}`));
      setTimeout(check, 20);
    };
    check();
  });
}

beforeAll(async () => {
  t = await startTestDb();
  listener = await t.pool.connect();
  await listener.query(`LISTEN ${SCHEMA_CHANGED_CHANNEL}`);
});

afterAll(async () => {
  listener.release();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

const FIXTURE_SCHEMA_ID = '11111111-1111-1111-1111-111111111111';

describe('notifySchemaChanged', () => {
  it('delivers exactly one notification, carrying the schema id and kind', async () => {
    const received = collectNotifications();

    await t.db.transaction().execute(async (trx) => {
      await notifySchemaChanged(trx, FIXTURE_SCHEMA_ID, 'mutated');
    });

    await waitFor(1, received);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ schemaId: FIXTURE_SCHEMA_ID, kind: 'mutated' });
    expect(typeof received[0].at).toBe('string');
    listener.removeAllListeners('notification');
  });

  it('a rolled-back transaction announces nothing', async () => {
    const received = collectNotifications();

    await expect(t.db.transaction().execute(async (trx) => {
      await notifySchemaChanged(trx, FIXTURE_SCHEMA_ID, 'mutated');
      throw new Error('boom — roll back everything in this transaction, including the NOTIFY');
    })).rejects.toThrow('boom');

    // Prove the negative with a positive: send a SECOND, real notification
    // and wait for exactly that one — if the rolled-back one had escaped, it
    // would already have arrived by the time this resolves.
    await t.db.transaction().execute(async (trx) => {
      await notifySchemaChanged(trx, FIXTURE_SCHEMA_ID, 'report');
    });
    await waitFor(1, received);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe('report');
    listener.removeAllListeners('notification');
  });

  it('the payload stays well under the 8000-byte NOTIFY cap and carries no title, report or owner id', async () => {
    const received = collectNotifications();
    await t.db.transaction().execute(async (trx) => {
      await notifySchemaChanged(trx, FIXTURE_SCHEMA_ID, 'report');
    });
    await waitFor(1, received);

    const payload = received[0] as unknown as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['at', 'kind', 'schemaId']);
    expect(JSON.stringify(payload).length).toBeLessThan(200);
    listener.removeAllListeners('notification');
  });

  it('two rapid mutations produce two notifications, not one coalesced into the other', async () => {
    const received = collectNotifications();

    await t.db.transaction().execute(async (trx) => {
      await notifySchemaChanged(trx, FIXTURE_SCHEMA_ID, 'mutated');
    });
    await t.db.transaction().execute(async (trx) => {
      await notifySchemaChanged(trx, FIXTURE_SCHEMA_ID, 'mutated');
    });

    await waitFor(2, received);
    expect(received).toHaveLength(2);
    listener.removeAllListeners('notification');
  });
});
