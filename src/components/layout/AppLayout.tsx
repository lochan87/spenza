import { type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { signOut } from '@/firebase/auth'
import { Sun, Moon, LogOut, LayoutDashboard, Receipt, Tag, Map, RepeatIcon, Target, Lightbulb } from 'lucide-react'

// Import logo — theme-aware
import logoMarkDark from '@/assets/logos/spenza-logo-mark-dark.svg'
import logoMarkLight from '@/assets/logos/spenza-logo-mark-light.svg'
import logoFullDark from '@/assets/logos/spenza-logo-full-dark.svg'
import logoFullLight from '@/assets/logos/spenza-logo-full-light.svg'

interface AppLayoutProps {
  children: ReactNode
}

const NAV_ITEMS = [
  { href: '/app', icon: LayoutDashboard, label: 'Overview', exact: true },
  { href: '/app/transactions', icon: Receipt, label: 'Transactions', exact: false },
  { href: '/app/trips', icon: Map, label: 'Trips', exact: false },
  { href: '/app/recurring', icon: RepeatIcon, label: 'Recurring', exact: false },
  { href: '/app/budgets', icon: Target, label: 'Budgets', exact: false },
  { href: '/app/insights', icon: Lightbulb, label: 'Insights', exact: false },
  { href: '/app/categories', icon: Tag, label: 'Categories', exact: false },
]

export function AppLayout({ children }: AppLayoutProps) {
  const { user } = useAuth()
  const { isDark, toggleTheme } = useTheme()
  const location = useLocation()

  const logoMark = isDark ? logoMarkDark : logoMarkLight
  const logoFull = isDark ? logoFullDark : logoFullLight

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)] transition-theme">
      {/* Top Header */}
      <header
        className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]"
        style={{ backdropFilter: 'blur(12px)' }}
      >
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          {/* Logo */}
          <Link to="/app" className="flex items-center gap-2.5 shrink-0">
            <img
              src={logoMark}
              alt="Spenza icon"
              className="h-8 w-8 rounded-lg object-contain"
            />
            <img
              src={logoFull}
              alt="Spenza"
              className="hidden h-7 sm:block object-contain"
              style={{ maxWidth: '110px' }}
            />
          </Link>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-1">
            {NAV_ITEMS.map(({ href, icon: Icon, label, exact }) => {
              const active = exact
                ? location.pathname === href
                : location.pathname.startsWith(href)
              return (
                <Link
                  key={href}
                  to={href}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-150 ${
                    active
                      ? 'bg-[var(--primary-muted)] text-[var(--primary)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              )
            })}
          </nav>

          {/* Right controls */}
          <div className="flex items-center gap-2">
            {/* Theme toggle */}
            <button
              id="theme-toggle-btn"
              onClick={toggleTheme}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition-all hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            {/* Avatar + sign out */}
            <div className="flex items-center gap-2">
              {user?.photoURL && (
                <img
                  src={user.photoURL}
                  alt={user.displayName ?? 'User'}
                  className="h-7 w-7 rounded-full ring-2 ring-[var(--primary-muted)]"
                />
              )}
              <button
                id="sign-out-btn"
                onClick={signOut}
                aria-label="Sign out"
                className="hidden sm:flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-[var(--text-muted)] transition-all hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="sr-only sm:not-sr-only">Sign out</span>
              </button>
            </div>
          </div>
        </div>

        {/* Mobile bottom nav (below header content) */}
      </header>

      {/* Main content */}
      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        {children}
      </main>

      {/* Mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 flex md:hidden items-center justify-around border-t border-[var(--border)] bg-[var(--surface)] px-1 pb-safe overflow-x-auto">
        {NAV_ITEMS.map(({ href, icon: Icon, label, exact }) => {
          const active = exact
            ? location.pathname === href
            : location.pathname.startsWith(href)
          return (
            <Link
              key={href}
              to={href}
              className={`flex flex-col items-center gap-0.5 px-3 py-2.5 text-[10px] font-medium shrink-0 transition-all ${
                active ? 'text-[var(--primary)]' : 'text-[var(--text-muted)]'
              }`}
            >
              <Icon className={`h-5 w-5 ${active ? 'stroke-[2.5]' : 'stroke-2'}`} />
              {label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}

// Re-export logos for use elsewhere
export { logoMarkDark, logoMarkLight, logoFullDark, logoFullLight }
