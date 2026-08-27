import { useAuth } from '../../auth/useAuth.js';

/**
 * Right-hand-end of the nav bar. Renders nothing on the desktop build
 * (`status === 'disabled'`, no auth plugin registered server-side), a
 * "Sign in" call to action for an anonymous web visitor, and the visitor's
 * name plus a "Sign out" action once authenticated.
 */
export default function UserMenu() {
  const { status, user, login, logout } = useAuth();

  if (status === 'disabled' || status === 'loading') return null;

  if (status === 'anonymous') {
    return (
      <button
        onClick={login}
        className="text-sm font-medium px-3 py-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
      >
        Sign in
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3 shrink-0">
      <span className="text-sm font-medium text-slate-300 truncate max-w-[12rem]">
        {user?.name ?? user?.email ?? 'Signed in'}
      </span>
      <button
        onClick={logout}
        className="text-sm font-medium px-3 py-1.5 rounded-md text-violet-400 hover:text-violet-300 hover:bg-slate-800 transition-colors"
      >
        Sign out
      </button>
    </div>
  );
}
