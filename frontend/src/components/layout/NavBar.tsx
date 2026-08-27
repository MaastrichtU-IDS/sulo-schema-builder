import { Link } from 'react-router-dom';
import UserMenu from './UserMenu.js';

export default function NavBar() {
  return (
    <nav className="bg-slate-900 border-b border-slate-800 px-4 py-0">
      <div className="container mx-auto max-w-7xl flex items-center gap-8 h-14">
        <Link to="/" className="flex items-center gap-2 shrink-0">
          <span className="text-white font-bold text-base tracking-tight">
            SULO<span className="text-violet-400"> Schema Builder</span>
          </span>
        </Link>

        <div className="flex-1" />

        <UserMenu />
      </div>
    </nav>
  );
}
