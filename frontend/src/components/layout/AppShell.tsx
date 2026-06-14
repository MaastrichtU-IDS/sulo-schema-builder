import type { ReactNode } from 'react';
import NavBar from './NavBar.js';

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <NavBar />
      <main className="flex-1 container mx-auto px-4 py-10 max-w-7xl">
        {children}
      </main>
      <footer className="border-t border-slate-200 bg-white py-5 text-center text-sm text-slate-400">
        SULO-Compliant Schema Builder <br />
        Schema generation by <a href="https://github.com/rcelebi/" className="text-violet-600 hover:underline" target="_blank" rel="noreferrer">Remzi Celebi</a>.
        Built with <a href="https://code.claude.com/docs/en/overview" className="text-violet-600 hover:underline" target="_blank" rel="noreferrer">Claude Code</a>.
        Supports OWL, RDFS, SHACL, UML exports.
      </footer>
    </div>
  );
}
