// Environment access shared by every config module. `dotenv/config` is imported
// here — the one module all the others go through — so `.env` is always loaded
// before the first `process.env` read, whichever config module loads first.

import 'dotenv/config';

export function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
