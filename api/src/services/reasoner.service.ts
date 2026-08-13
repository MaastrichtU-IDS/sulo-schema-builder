// Server-side full OWL DL consistency reasoning via ROBOT + HermiT.
//
// The in-browser reasoner (frontend) only materialises a named-class OWL-RL
// subset. To catch the "Tier C" errors that genuinely require a tableau
// reasoner — owl:complementOf contradictions, owl:allValuesFrom propagation,
// owl:someValuesFrom unsatisfiability, and owl:disjointUnionOf covering — we run
// HermiT (full SROIQ DL) over the user's OWL merged with the complete SULO
// ontology, and parse ROBOT's `explain` output into structured clashes.
//
// SULO is merged from a bundled copy (config.reasoner.suloPath) rather than
// resolved via owl:imports, since the import IRI does not dereference inside
// the container.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { resolveJava } from './java.service.js';
import { ensureRobotJar } from './robot.service.js';
import { getSuloStatus, resolveSuloPath } from './sulo.service.js';

export type ServerClashKind = 'unsatisfiable-class' | 'inconsistent-ontology';

export interface ServerClash {
  kind: ServerClashKind;
  /** IRI of the unsatisfiable class (omitted for whole-ontology inconsistency). */
  iri?: string;
  /** Short label for display. */
  label?: string;
  /** Human-readable, link-stripped explanation tree from the reasoner. */
  explanation: string;
}

export interface ConsistencyReport {
  consistent: boolean;
  reasoner: 'HermiT';
  clashes: ServerClash[];
}

export class ReasonerUnavailableError extends Error {}

const ROBOT_NS = 'http://www.w3.org/2002/07/owl#Nothing';

// ─── Markdown parsing (pure — unit-tested without a JVM) ────────────────────────

/** Replace Markdown `[text](iri)` links with their text, leaving plain prose. */
export function stripMdLinks(s: string): string {
  return s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');
}

/** Extract the first `[label](iri)` link from a line, if any. */
function firstLink(line: string): { label: string; iri: string } | null {
  const m = /\[([^\]]*)\]\(([^)]*)\)/.exec(line);
  return m ? { label: m[1], iri: m[2] } : null;
}

/**
 * Split a ROBOT `explain` Markdown report into its per-entailment blocks.
 * Each block starts with a `## ... ##` header and runs until the next header
 * or the trailing `# Axiom Impact` / `# Ontologies used` sections.
 */
function explanationBlocks(md: string): Array<{ header: string; body: string }> {
  const trimmed = md.trim();
  if (!trimmed || /^No explanations found\.?$/i.test(trimmed)) return [];

  const blocks: Array<{ header: string; body: string }> = [];
  const lines = md.split('\n');
  let header: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (header !== null) blocks.push({ header, body: body.join('\n').trim() });
    header = null;
    body = [];
  };

  for (const line of lines) {
    if (/^#\s/.test(line) && !/^##\s/.test(line)) {
      // A top-level section like "# Axiom Impact" ends the explanation blocks.
      flush();
      break;
    }
    if (/^##\s/.test(line)) {
      flush();
      header = line.replace(/^##\s*/, '').replace(/\s*##\s*$/, '').trim();
      continue;
    }
    if (header !== null) body.push(line);
  }
  flush();
  return blocks;
}

/** Parse a `--mode unsatisfiability` report into one clash per unsatisfiable class. */
export function parseUnsatisfiability(md: string): ServerClash[] {
  return explanationBlocks(md).map(({ header, body }) => {
    const link = firstLink(header);
    return {
      kind: 'unsatisfiable-class' as const,
      iri: link?.iri,
      label: link?.label,
      explanation: stripMdLinks(body),
    };
  }).filter((c) => c.iri && c.iri !== ROBOT_NS);
}

/**
 * Parse a `--mode inconsistency` report. The header is always
 * `Thing SubClassOf Nothing`, so we surface the individuals named in the body
 * (their `Type` assertions) to make the message actionable.
 */
export function parseInconsistency(md: string): ServerClash | null {
  const blocks = explanationBlocks(md);
  if (!blocks.length) return null;
  const body = blocks[0].body;

  // Individuals appear as "[x](iri) Type [class](iri)" lines.
  const individuals = new Set<string>();
  for (const line of body.split('\n')) {
    const m = /\[([^\]]*)\]\([^)]*\)\s+Type\s+/.exec(line.trim());
    if (m) individuals.add(m[1]);
  }
  const who = individuals.size ? ` (involving: ${[...individuals].join(', ')})` : '';

  return {
    kind: 'inconsistent-ontology',
    explanation:
      `The ontology is logically inconsistent${who}. ` +
      `A reasoner can derive a contradiction, so it has no valid model:\n\n` +
      stripMdLinks(body),
  };
}

// ─── ROBOT invocation ───────────────────────────────────────────────────────────

// Packaged builds bundle resources/sulo.ttl as a pkg asset, readable via Node's
// (patched) fs — but the JVM ROBOT runs as opens files directly against the real
// filesystem (both the jar it loads *and* any --input path passed on the command
// line), so it has to be extracted to a real path once per process before
// `java -jar ... --input ...` can use it. Memoized: the file doesn't change at
// runtime.
//
// robot.jar no longer needs this: it is downloaded to the app-data dir rather
// than embedded (robot.service.ts), so it is already a real path. Neither does a
// downloaded or SULO_TTL_PATH-overridden sulo.ttl — only the bundled copy lives
// inside the snapshot.
const extracted = new Map<string, Promise<string>>();

async function extractForJvm(name: string, sourcePath: string): Promise<string> {
  let promise = extracted.get(name);
  if (!promise) {
    promise = (async () => {
      const dest = join(config.appDataDir, name);
      await mkdir(config.appDataDir, { recursive: true });
      await copyFile(sourcePath, dest);
      return dest;
    })();
    extracted.set(name, promise);
  }
  return promise;
}

function suloPathForJvm(): Promise<string> {
  const path = resolveSuloPath();
  return config.isPackaged && getSuloStatus().source === 'bundled'
    ? extractForJvm('sulo.ttl', path)
    : Promise.resolve(path);
}

/**
 * Build the ROBOT invocation for this environment.
 *
 * Docker and local dev call a `robot` launcher on PATH, which brings its own
 * JRE. Packaged desktop builds have neither, so they resolve the user's JVM and
 * the downloaded jar first — and surface a specific ReasonerUnavailableError
 * when either is missing, rather than letting execFile fail with a bare ENOENT.
 */
async function robotInvocation(args: string[]): Promise<{ command: string; args: string[] }> {
  if (!config.isPackaged) return { command: config.reasoner.command, args };

  const java = await resolveJava();
  if (!java.available || !java.path) {
    throw new ReasonerUnavailableError(
      java.reason === 'too_old'
        ? `Java ${java.version} was found, but ROBOT needs 11 or newer.`
        : 'No Java runtime was found. Install Java 11+ or set its path in the consistency panel.',
    );
  }

  let jar: string;
  try {
    jar = await ensureRobotJar();
  } catch (err) {
    throw new ReasonerUnavailableError(
      `The ROBOT reasoner could not be downloaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { command: java.path, args: [...config.reasoner.baseArgs, jar, ...args] };
}

async function runRobot(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { command, args: fullArgs } = await robotInvocation(args);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      fullArgs,
      { timeout: config.reasoner.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // ENOENT → robot/JRE not installed.
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new ReasonerUnavailableError('ROBOT executable not found on the server'));
          } else {
            reject(Object.assign(err, { stdout, stderr }));
          }
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Run a full OWL DL consistency check on the supplied OWL Turtle.
 * Merges the bundled SULO ontology, then asks HermiT (via ROBOT) for
 * inconsistency and unsatisfiability explanations.
 */
export async function reasonOntologyDL(turtleOwl: string): Promise<ConsistencyReport> {
  if (!config.reasoner.enabled) {
    throw new ReasonerUnavailableError('Server-side reasoning is disabled');
  }

  const dir = await mkdtemp(join(tmpdir(), 'sulo-reason-'));
  const inputPath  = join(dir, 'input.ttl');
  const mergedPath = join(dir, 'merged.ttl');
  const inconPath  = join(dir, 'incon.md');
  const unsatPath  = join(dir, 'unsat.md');
  const { maxExplanations } = config.reasoner;

  try {
    await writeFile(inputPath, turtleOwl, 'utf8');
    const suloPath = await suloPathForJvm();

    // Merge SULO + the user's OWL into a single materialised file FIRST, then
    // run explain against that file. Chaining `merge … explain` in one ROBOT
    // invocation is unreliable: the merged ontology (and its imports) is not
    // fully applied before `explain` runs, so it silently returns "No
    // explanations found" for ontologies that are in fact inconsistent
    // (notably datatype-driven contradictions). A materialised file avoids that.
    await runRobot(['merge', '--input', suloPath, '--input', inputPath, '--output', mergedPath]);

    // 1. Inconsistency first: if the merged ontology is inconsistent, every
    //    class is unsatisfiable, so the unsatisfiability pass would be noise.
    await runRobot([
      'explain', '--input', mergedPath, '--reasoner', 'HermiT', '--mode', 'inconsistency',
      '--max', String(maxExplanations), '--explanation', inconPath,
    ]);
    const inconMd = await readFile(inconPath, 'utf8').catch(() => '');
    const inconClash = parseInconsistency(inconMd);
    if (inconClash) {
      return { consistent: false, reasoner: 'HermiT', clashes: [inconClash] };
    }

    // 2. Coherent ontology → explain every unsatisfiable class.
    await runRobot([
      'explain', '--input', mergedPath, '--reasoner', 'HermiT', '--mode', 'unsatisfiability',
      '--unsatisfiable', 'all', '--max', String(maxExplanations), '--explanation', unsatPath,
    ]);
    const unsatMd = await readFile(unsatPath, 'utf8').catch(() => '');
    const clashes = parseUnsatisfiability(unsatMd);

    return { consistent: clashes.length === 0, reasoner: 'HermiT', clashes };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
