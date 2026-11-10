import { signInWithGoogle, signInAsTestUser } from '@/firebase/auth'
import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTheme } from '@/hooks/useTheme'
import { Sun, Moon } from 'lucide-react'

import logoFullDark from '@/assets/logos/spenza-logo-full-dark.svg'
import logoFullLight from '@/assets/logos/spenza-logo-full-light.svg'
import SyncDark from '@/assets/logos/SyncDark.png'
import SyncLight from '@/assets/logos/SyncLight.png'

/**
 * Login page — Google Sign-In with real branding.
 * Shows the full Spenza wordmark logo + themed splash image.
 */
export function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { isDark, toggleTheme } = useTheme()
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/app'

  const logoFull = isDark ? logoFullDark : logoFullLight
  const splashImage = isDark ? SyncDark : SyncLight

  async function handleGoogleSignIn() {
    setError(null)
    setLoading(true)
    try {
      await signInWithGoogle()
      navigate(from, { replace: true })
    } catch (err) {
      console.error('[Spenza] Sign-in error:', err)
      setError('Sign in failed. Check popup blockers and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleEmulatorSignIn() {
    setError(null)
    setLoading(true)
    try {
      await signInAsTestUser()
      navigate(from, { replace: true })
    } catch (err) {
      console.error('[Spenza] Emulator sign-in error:', err)
      setError('Emulator sign in failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] p-5 overflow-hidden">
      {/* Background blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-[var(--primary)] opacity-[0.06] blur-3xl" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-[var(--accent)] opacity-[0.06] blur-3xl" />
      </div>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        aria-label="Toggle theme"
        className="absolute top-4 right-4 flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] shadow-[var(--shadow-sm)] transition-all hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>

      <div className="relative z-10 flex w-full max-w-sm flex-col items-center gap-8">
        {/* Splash image */}
        <div className="flex items-center justify-center">
          <img
            src={splashImage}
            alt="Spenza illustration"
            className="h-32 w-32 rounded-3xl object-contain shadow-[var(--shadow-lg)]"
          />
        </div>

        {/* Logo wordmark */}
        <div className="flex flex-col items-center gap-2">
          <img
            src={logoFull}
            alt="Spenza"
            className="h-10 object-contain"
            style={{ maxWidth: '180px' }}
          />
          <p className="text-sm text-[var(--text-muted)]">
            Your personal expense tracker
          </p>
        </div>

        {/* Sign-in card */}
        <div
          className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-7 shadow-[var(--shadow-md)]"
        >
          <p className="mb-5 text-center text-sm text-[var(--text-muted)]">
            Sign in to access your expenses
          </p>

          <button
            id="google-sign-in-btn"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="flex w-full items-center justify-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-5 py-3 text-sm font-medium text-[var(--text-primary)] shadow-[var(--shadow-sm)] transition-all duration-200 hover:border-[var(--border-strong)] hover:bg-[var(--surface-3)] hover:shadow-[var(--shadow-md)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--primary)]" />
            ) : (
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden>
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
            )}
            <span>{loading ? 'Signing in…' : 'Continue with Google'}</span>
          </button>

          {import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' && (
            <button
              id="emulator-test-sign-in-btn"
              type="button"
              onClick={handleEmulatorSignIn}
              disabled={loading}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--primary)] bg-[var(--primary-muted)] px-5 py-2.5 text-xs font-semibold text-[var(--primary)] shadow-[var(--shadow-sm)] transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>Sign in with Emulator Test User</span>
            </button>
          )}

          {error && (
            <p className="mt-3 text-center text-xs text-[var(--danger)]">{error}</p>
          )}
        </div>

        <p className="text-center text-xs text-[var(--text-subtle)]">
          Single-user personal app — your data stays private.
        </p>
      </div>
    </div>
  )
}
