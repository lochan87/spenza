import { useAuth } from '@/hooks/useAuth'
import { signOut } from '@/firebase/auth'
import { SchemaTestPanel } from '@/components/debug/SchemaTestPanel'
import { LogOut, Zap } from 'lucide-react'

/**
 * Bare-minimum app shell for Phase 1.
 * Shows auth state + the schema/Firestore test panel.
 * No dashboard, no charts, no add-expense form — those are later phases.
 */
export function AppPage() {
  const { user } = useAuth()

  return (
    <div className="min-h-screen bg-[var(--color-background)] p-6">
      {/* Header */}
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-primary)]">
            <Zap className="h-5 w-5 text-white" fill="white" />
          </div>
          <span className="text-lg font-bold gradient-text">Spenza</span>
        </div>

        <div className="flex items-center gap-3">
          {user?.photoURL && (
            <img
              src={user.photoURL}
              alt={user.displayName ?? 'User'}
              className="h-8 w-8 rounded-full ring-2 ring-[var(--color-primary-muted)]"
            />
          )}
          <span className="text-sm text-[var(--color-text-muted)]">{user?.displayName}</span>
          <button
            id="sign-out-btn"
            onClick={signOut}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </header>

      {/* Auth confirmation */}
      <div className="glass-card mb-6 p-5">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
          Phase 1 — Auth &amp; Schema Verification
        </h2>
        <div className="grid gap-2 text-sm">
          <div className="flex gap-2">
            <span className="text-[var(--color-text-muted)]">UID:</span>
            <code className="font-mono text-[var(--color-primary)]">{user?.uid}</code>
          </div>
          <div className="flex gap-2">
            <span className="text-[var(--color-text-muted)]">Email:</span>
            <span className="text-[var(--color-text)]">{user?.email}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-[var(--color-text-muted)]">Provider:</span>
            <span className="text-[var(--color-accent)]">Google</span>
          </div>
        </div>
      </div>

      {/* Schema + Firestore test panel */}
      <SchemaTestPanel />
    </div>
  )
}
