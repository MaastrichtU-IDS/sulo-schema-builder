// A generic per-key debouncer: coalesces a burst of `schedule(key)` calls
// into one `fire(key)`, with two timers per key —
//
//   - an IDLE timer, reset on every `schedule(key)` call, so a quiet moment
//     of `idleMs` is what actually triggers a fire;
//   - a MAX timer, started once per burst and never reset, so a key that is
//     scheduled continuously (an edit every couple of seconds, say) still
//     fires at least every `maxMs` rather than being pushed back forever.
//
// Whichever fires first cancels the other and clears both from the map, so a
// key never fires twice for the same burst. Carries no reasoning-specific
// knowledge — modules/reasoning/pipeline.ts is the one caller today, but
// nothing here names a schema.

export interface DebounceOptions {
  idleMs: number;
  maxMs: number;
}

export interface Debouncer {
  /** (Re)start the idle timer for `key`; start its max timer if not already running. */
  schedule(key: string): void;
  /** Cancel every pending timer without firing. Used to stop leaking timers (tests, shutdown). */
  stopAll(): void;
}

export function createDebouncer(fire: (key: string) => void, opts: DebounceOptions): Debouncer {
  const idleTimers = new Map<string, NodeJS.Timeout>();
  const maxTimers = new Map<string, NodeJS.Timeout>();

  function clear(key: string): void {
    const idle = idleTimers.get(key);
    if (idle) clearTimeout(idle);
    const max = maxTimers.get(key);
    if (max) clearTimeout(max);
    idleTimers.delete(key);
    maxTimers.delete(key);
  }

  function fireOnce(key: string): void {
    // Both timers for this key are cleared before `fire` runs, not after: if
    // `fire` itself calls `schedule(key)` again synchronously (it does not
    // today, but a future caller might), it must start a fresh burst rather
    // than colliding with this one's now-firing timers.
    clear(key);
    fire(key);
  }

  return {
    schedule(key) {
      const existingIdle = idleTimers.get(key);
      if (existingIdle) clearTimeout(existingIdle);
      // `.unref()`: a pending debounce timer must never be the reason a
      // process (or a test run) fails to exit. The real server stays alive
      // on its HTTP listener regardless; a test that creates a schema and
      // never awaits the check it schedules would otherwise leave a live
      // timer behind for every such case across the whole suite.
      idleTimers.set(key, setTimeout(() => fireOnce(key), opts.idleMs).unref());

      if (!maxTimers.has(key)) {
        maxTimers.set(key, setTimeout(() => fireOnce(key), opts.maxMs).unref());
      }
    },
    stopAll() {
      for (const t of idleTimers.values()) clearTimeout(t);
      for (const t of maxTimers.values()) clearTimeout(t);
      idleTimers.clear();
      maxTimers.clear();
    },
  };
}
