import { Link, NavLink } from 'react-router-dom';

const NAV_LINKS = [
  { to: '/ontology', label: 'Schema Builder' },
  { to: '/mapping', label: 'Schema Mapping' },
];

export default function NavBar() {
  return (
    <nav className="bg-slate-900 border-b border-slate-800 px-4 py-0">
      <div className="container mx-auto max-w-7xl flex items-center gap-8 h-14">
        <Link to="/" className="flex items-center gap-2 shrink-0">
          <span className="text-white font-bold text-base tracking-tight">
            SULO<span className="text-violet-400"> Schema Builder</span>
          </span>
        </Link>

        <div className="flex gap-1 flex-1">
          {NAV_LINKS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `text-sm font-medium px-3 py-1.5 rounded-md transition-colors ${
                  isActive
                    ? 'bg-slate-700 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  );
}
