import type { Database } from 'better-sqlite3';

// App-level key/value state (the user-supplied Java path, the last SULO update
// check). Services like java.service and sulo.service need this but run outside
// a request, so they can't reach `fastify.db` the way routes do. The db plugin
// binds the open handle here once at startup instead of every caller having to
// thread a Database through.
let db: Database | null = null;

export function bindSettingsDb(database: Database): void {
  db = database;
}

/** Test seam: drop the bound handle so a suite can rebind a fresh in-memory db. */
export function unbindSettingsDb(): void {
  db = null;
}

export function getSetting(key: string): string | null {
  if (!db) return null;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  if (!db) return;
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function deleteSetting(key: string): void {
  if (!db) return;
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export const SETTING_JAVA_PATH = 'java.path';
export const SETTING_SULO_LAST_CHECKED = 'sulo.lastChecked';
