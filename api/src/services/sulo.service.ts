// Keeps the SULO copy used for reasoning in step with the published ontology.
//
// The bundled api/resources/sulo.ttl was frozen at whatever version shipped
// with the build, but the app reaches live SULO from two other directions: the
// upper-concept autocomplete dereferences https://w3id.org/sulo/ on every
// request, and generated OWL declares `owl:imports <https://w3id.org/sulo/>`,
// so anyone else reasoning over an export gets whatever is current. Left alone,
// three different SULO versions are in play at once — and a user can align a
// class to a SULO term that exists live but not in the bundled copy, which
// HermiT then treats as an undeclared IRI: no error, just weaker entailments,
// and an ontology we call "consistent" that may not be consistent against the
// SULO its own export imports.
//
// So: keep the bundled copy as the offline fallback (it's 17 KB, and the app
// has to work on first launch with no network), check for a newer published
// version in the background, and adopt it when there is one. The version
// actually used is reported through /reason/status so a recorded consistency
// result can say which SULO produced it.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Quad } from 'n3';
import { config } from '../config.js';
import { fetchOntologyDocument, parseOntology } from '../rdf/fetchOntology.js';
import { getSetting, setSetting, SETTING_SULO_LAST_CHECKED } from '../db/settings.js';

const RDF_TYPE     = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';
const OWL_CLASS    = 'http://www.w3.org/2002/07/owl#Class';
const OWL_VERSION_INFO = 'http://www.w3.org/2002/07/owl#versionInfo';
const DCTERMS_MODIFIED = 'http://purl.org/dc/terms/modified';

// SULO is deliberately minimal (21 classes at 0.2.14), so this floor only has
// to be high enough to reject an HTML captive-portal page or a truncated body
// while leaving room for the ontology to shrink.
const MIN_SULO_CLASSES = 10;

export type SuloSource = 'bundled' | 'downloaded' | 'override';

export interface SuloStatus {
  version?: string;
  modified?: string;
  source: SuloSource;
  path: string;
  /** ISO timestamp of the last completed update check, if one has run. */
  checkedAt?: string;
  /** Set when the most recent check failed; the previous copy stays in use. */
  updateError?: string;
}

export interface SuloMetadata {
  iri?: string;
  version?: string;
  modified?: string;
}

// ─── Pure helpers (unit-tested without network or filesystem) ──────────────────

/**
 * Compare two dotted version strings numerically, segment by segment.
 *
 * A lexical compare gets SULO's own history wrong — 0.2.14 succeeds 0.2.3, but
 * "0.2.14" < "0.2.3" as strings. Returns null when either side has a segment
 * that isn't a number, so callers can fall back to dcterms:modified.
 */
export function compareVersions(a: string, b: string): number | null {
  const left  = a.trim().split(/[._-]/);
  const right = b.trim().split(/[._-]/);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = i < left.length  ? Number(left[i])  : 0;
    const y = i < right.length ? Number(right[i]) : 0;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Read the ontology header's version metadata, preferring the SULO IRI itself. */
export function readSuloMetadata(quads: Quad[]): SuloMetadata {
  const ontologies = quads
    .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === OWL_ONTOLOGY)
    .map((q) => q.subject.value);
  if (!ontologies.length) return {};

  const iri = ontologies.find((s) => s === config.reasoner.suloUrl) ?? ontologies[0];
  const valueOf = (predicate: string) =>
    quads.find((q) => q.subject.value === iri && q.predicate.value === predicate)?.object.value;

  return { iri, version: valueOf(OWL_VERSION_INFO), modified: valueOf(DCTERMS_MODIFIED) };
}

/**
 * Guard against adopting something that parsed but isn't SULO.
 *
 * robot.jar is protected by a pinned SHA-256; SULO is a moving target so there
 * is no digest to pin, and the equivalent protection has to be semantic. Without
 * it a captive-portal login page or a half-written response replaces a working
 * ontology and breaks reasoning until the user finds the file by hand.
 */
export function validateSulo(quads: Quad[]): { ok: boolean; reason?: string } {
  const { iri } = readSuloMetadata(quads);
  if (!iri) return { ok: false, reason: 'No owl:Ontology declaration found.' };

  const classes = new Set(
    quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === OWL_CLASS)
         .map((q) => q.subject.value),
  );
  if (classes.size < MIN_SULO_CLASSES) {
    return { ok: false, reason: `Only ${classes.size} owl:Class declarations — expected at least ${MIN_SULO_CLASSES}.` };
  }
  return { ok: true };
}

/**
 * Is `candidate` newer than `current`? Prefers owl:versionInfo and falls back to
 * dcterms:modified when either version is missing or not numerically comparable.
 */
export function isNewer(current: SuloMetadata, candidate: SuloMetadata): boolean {
  if (current.version && candidate.version) {
    const diff = compareVersions(candidate.version, current.version);
    if (diff !== null) return diff > 0;
  }
  if (current.modified && candidate.modified) return candidate.modified > current.modified;
  // No usable version signal on either side — don't churn the cached copy.
  return false;
}

// ─── Resolution + state ────────────────────────────────────────────────────────

let updateError: string | undefined;

function currentSource(): SuloSource {
  // A SULO_TTL_PATH override means the operator picked the file explicitly;
  // never replace it.
  if (config.reasoner.suloPath !== config.reasoner.suloBundledPath) return 'override';
  return existsSync(config.reasoner.suloCachePath) ? 'downloaded' : 'bundled';
}

/** Path to the SULO copy reasoning should use right now. */
export function resolveSuloPath(): string {
  switch (currentSource()) {
    case 'override':   return config.reasoner.suloPath;
    case 'downloaded': return config.reasoner.suloCachePath;
    default:           return config.reasoner.suloBundledPath;
  }
}

function metadataOf(path: string): SuloMetadata {
  try {
    const parsed = parseOntology(readFileSync(path, 'utf-8'));
    return parsed ? readSuloMetadata(parsed.quads) : {};
  } catch {
    return {};
  }
}

export function getSuloStatus(): SuloStatus {
  const path = resolveSuloPath();
  const { version, modified } = metadataOf(path);
  return {
    version,
    modified,
    source: currentSource(),
    path,
    checkedAt: getSetting(SETTING_SULO_LAST_CHECKED) ?? undefined,
    ...(updateError ? { updateError } : {}),
  };
}

function checkIsDue(): boolean {
  const last = getSetting(SETTING_SULO_LAST_CHECKED);
  if (!last) return true;
  const at = Date.parse(last);
  if (Number.isNaN(at)) return true;
  return Date.now() - at >= config.reasoner.suloCheckIntervalMs;
}

/**
 * Fetch the published SULO and adopt it if it's newer than the copy in use.
 * Returns true when a new copy was written. Never throws: being offline is the
 * normal case for a desktop app, and it just means "keep what we have".
 */
export async function checkForSuloUpdate(force = false): Promise<boolean> {
  if (currentSource() === 'override') return false;
  if (!force && !checkIsDue()) return false;

  updateError = undefined;

  const doc = await fetchOntologyDocument(config.reasoner.suloUrl);
  if (!doc) {
    updateError = `Could not reach ${config.reasoner.suloUrl}.`;
    return false;
  }

  const valid = validateSulo(doc.quads);
  if (!valid.ok) {
    updateError = `Ignored the response from ${config.reasoner.suloUrl}: ${valid.reason}`;
    return false;
  }

  // Record the attempt whether or not it produced an update, so an unchanged
  // upstream doesn't mean re-fetching on every launch.
  setSetting(SETTING_SULO_LAST_CHECKED, new Date().toISOString());

  const candidate = readSuloMetadata(doc.quads);
  if (!isNewer(metadataOf(resolveSuloPath()), candidate)) return false;

  const target = config.reasoner.suloCachePath;
  const partial = `${target}.part`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(partial, doc.text, 'utf-8');
    await rename(partial, target);
    return true;
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {});
    updateError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/** Kick the check off without awaiting it — used at server start. */
export function startSuloUpdateCheck(): void {
  checkForSuloUpdate().catch(() => {
    /* checkForSuloUpdate already records updateError */
  });
}

/** Test seam. */
export function resetSuloUpdateError(): void {
  updateError = undefined;
}
