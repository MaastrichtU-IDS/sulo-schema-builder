import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';

// Derived from config.resourcesDir rather than this file's own __dirname —
// pkg's packaged runtime gives every ESM module the *entry file's*
// directory as its ambient __dirname, not each file's own (see
// pkgDirname.ts), so a nested file like this one can't reliably resolve
// its own location; config.ts's resolution happens to be safe since
// dist/config.js sits directly in dist/.
const SCHEMA_SQL_PATH = resolve(config.resourcesDir, 'db-schema.sql');

// `CREATE TABLE IF NOT EXISTS` in schema.sql only applies to brand-new
// databases — a column added to the schema later needs an explicit ALTER
// for databases created before that column existed.
function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openDatabase(path: string = config.db.path): Database.Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_SQL_PATH, 'utf-8'));

  ensureColumn(db, 'schemas', 'base_uri', 'TEXT');

  return db;
}
