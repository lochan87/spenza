import { signInWithGoogle } from '@/firebase/auth'
import { LogIn, Zap } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

/**
 * Bare-minimum login page for Phase 1.
 * Just a Google Sign-In button — no design polish yet (that's a later phase).
 * Auth state is wired end-to-end: sign in here → UID printed to console → redirect to app.
 */
export function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: Location })?.from?.pathname ?? '/app'

  async function handleGoogleSignIn() {
    setError(null)
    setLoading(true)
    try {
      await signInWithGoogle()
      navigate(from, { replace: true })
    } catch (err) {
      console.error('[Spenza] Sign-in error:', err)
      setError('Sign in failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--color-background)] p-6">
      <div className="glass-card flex w-full max-w-sm flex-col items-center gap-8 p-10">
        {/* Logo mark */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-primary)] glow-primary">
            <Zap className="h-7 w-7 text-white" fill="white" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight gradient-text">Spenza</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Your personal finance tracker</p>
          </div>
        </div>

        {/* Sign-in */}
        <div className="flex w-full flex-col gap-3">
          <button
            id="google-sign-in-btn"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="flex w-full items-center justify-center gap-3 rounded-xl bg-white px-5 py-3 text-sm font-medium text-gray-800 shadow-md transition-all duration-200 hover:bg-gray-50 hover:shadow-lg active:scale-[0.98] disabled:opacity-60"
          >
            {loading ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
            ) : (
              <LogIn className="h-4 w-4" />
            )}
            {loading ? 'Signing in…' : 'Continue with Google'}
          </button>

          {error && (
            <p className="text-center text-xs text-[var(--color-danger)]">{error}</p>
          )}
        </div>

        <p className="text-center text-xs text-[var(--color-text-subtle)]">
          Single-user personal app — your data stays yours.
        </p>
      </div>
    </div>
  )
}
