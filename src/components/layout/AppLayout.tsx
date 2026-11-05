import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { signOut } from '@/firebase/auth'
import {
  Sun,
  Moon,
  LogOut,
  LayoutDashboard,
  Receipt,
  Tag,
  Map,
  RepeatIcon,
  Target,
  Lightbulb,
  Upload,
  Settings,
  Users,
  ChevronDown,
  MoreHorizontal,
   type LucideIcon,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Import logos — theme-aware
import logoMarkDark from '@/assets/logos/spenza-logo-mark-dark.svg'
import logoMarkLight from '@/assets/logos/spenza-logo-mark-light.svg'
import logoFullDark from '@/assets/logos/spenza-logo-full-dark.svg'
import logoFullLight from '@/assets/logos/spenza-logo-full-light.svg'

interface AppLayoutProps {
  children: ReactNode
}

interface NavItem {
  href: string
  icon: LucideIcon
  label: string
  exact: boolean
  separatorBefore?: boolean
}

/** Primary destinations — always visible in top bar (desktop/tablet) and bottom bar (mobile) */
const PRIMARY_NAV_ITEMS: NavItem[] = [
  { href: '/app', icon: LayoutDashboard, label: 'Overview', exact: true },
  { href: '/app/transactions', icon: Receipt, label: 'Transactions', exact: false },
  { href: '/app/budgets', icon: Target, label: 'Budgets', exact: false },
  { href: '/app/insights', icon: Lightbulb, label: 'Insights', exact: false },
]

/** Secondary destinations — grouped under "More" ordered by realistic frequency of use */
const SECONDARY_NAV_ITEMS: NavItem[] = [
  { href: '/app/people', icon: Users, label: 'Friends & Splits', exact: false },
  { href: '/app/recurring', icon: RepeatIcon, label: 'Recurring', exact: false },
  { href: '/app/trips', icon: Map, label: 'Trips', exact: false },
  { href: '/app/categories', icon: Tag, label: 'Categories', exact: false },
  { href: '/app/import', icon: Upload, label: 'Import', exact: false, separatorBefore: true },
  { href: '/app/settings', icon: Settings, label: 'Settings', exact: false },
]

function isRouteActive(pathname: string, item: NavItem): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href)
}

export function AppLayout({ children }: AppLayoutProps) {
  const { user } = useAuth()
  const { isDark, toggleTheme } = useTheme()
  const location = useLocation()

  // Track profile photo load failure so we gracefully fall back to initials
  const [imgError, setImgError] = useState(false)
  useEffect(() => {
    setImgError(false)
  }, [user?.photoURL])

  const logoFull = isDark ? logoFullDark : logoFullLight

  const activeSecondaryItem = SECONDARY_NAV_ITEMS.find(item =>
    isRouteActive(location.pathname, item)
  )
  const isSecondaryActive = Boolean(activeSecondaryItem)

  const userInitial = (
    user?.displayName?.trim()?.[0] ||
    user?.email?.trim()?.[0] ||
    'U'
  ).toUpperCase()

  const userTooltip = user?.displayName
    ? `${user.displayName}${user.email ? ` (${user.email})` : ''}`
    : user?.email ?? 'Signed in'

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)] transition-theme">
      {/* Top Header */}
      <header
        className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)]/95 shadow-[var(--shadow-sm)]"
        style={{ backdropFilter: 'blur(12px)' }}
      >
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          {/* Logo — single full logo across all viewports (32px mobile, 36px desktop) */}
          <Link
            to="/app"
            className="flex shrink-0 items-center focus-visible:outline-none"
          >
            <img
              src={logoFull}
              alt="Spenza"
              className="h-8 w-auto object-contain sm:h-9"
              style={{ maxWidth: '136px' }}
            />
          </Link>

          {/* Desktop & Tablet Primary + Overflow Nav */}
          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-1 lg:gap-1.5"
          >
            {PRIMARY_NAV_ITEMS.map(item => {
              const Icon = item.icon
              const active = isRouteActive(location.pathname, item)
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-150 lg:px-3 lg:text-sm ${
                    active
                      ? 'bg-[var(--primary-muted)] text-[var(--primary)] font-semibold'
                      : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              )
            })}

            {/* Secondary "More" Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  id="desktop-more-nav-btn"
                  aria-label="More navigation options"
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-150 outline-none cursor-pointer lg:px-3 lg:text-sm ${
                    isSecondaryActive
                      ? 'bg-[var(--primary-muted)] text-[var(--primary)] font-semibold'
                      : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] data-[state=open]:bg-[var(--surface-2)] data-[state=open]:text-[var(--text-primary)]'
                  }`}
                >
                  {activeSecondaryItem ? (
                    <>
                      <activeSecondaryItem.icon className="h-4 w-4 shrink-0" />
                      <span>{activeSecondaryItem.label}</span>
                    </>
                  ) : (
                    <>
                      <MoreHorizontal className="h-4 w-4 shrink-0" />
                      <span>More</span>
                    </>
                  )}
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-75 transition-transform duration-150" />
                </button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end" sideOffset={8} className="w-48">
                {SECONDARY_NAV_ITEMS.map(item => {
                  const Icon = item.icon
                  const active = isRouteActive(location.pathname, item)
                  return (
                    <div key={item.href}>
                      {item.separatorBefore && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        asChild
                        className={
                          active
                            ? 'bg-[var(--primary-muted)] text-[var(--primary)] font-semibold focus:bg-[var(--primary-muted)] focus:text-[var(--primary)]'
                            : ''
                        }
                      >
                        <Link
                          to={item.href}
                          aria-current={active ? 'page' : undefined}
                          className="flex w-full items-center justify-between"
                        >
                          <span className="flex items-center gap-2.5">
                            <Icon className="h-4 w-4 shrink-0" />
                            <span>{item.label}</span>
                          </span>
                          {active && (
                            <span
                              className="h-1.5 w-1.5 rounded-full bg-[var(--primary)]"
                              aria-hidden="true"
                            />
                          )}
                        </Link>
                      </DropdownMenuItem>
                    </div>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>

          {/* Right Account Area — Unified Pill Cluster (Theme + Avatar + Sign Out) */}
          <div className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)]/70 p-1">
            {/* Theme toggle */}
            <button
              id="theme-toggle-btn"
              type="button"
              onClick={toggleTheme}
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] transition-all hover:bg-[var(--surface)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            {/* User Avatar — Google photo with no-referrer + graceful initials fallback */}
            {user && (
              user.photoURL && !imgError ? (
                <img
                  src={user.photoURL}
                  alt={user.displayName ?? 'User'}
                  title={userTooltip}
                  referrerPolicy="no-referrer"
                  onError={() => setImgError(true)}
                  className="h-7 w-7 shrink-0 rounded-full object-cover ring-2 ring-[var(--primary-muted)]"
                />
              ) : (
                <div
                  title={userTooltip}
                  aria-label={user.displayName ?? 'User'}
                  className="flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full bg-[var(--primary)] text-xs font-semibold text-white ring-2 ring-[var(--primary-muted)]"
                >
                  {userInitial}
                </div>
              )
            )}

            {/* Sign out — danger hover per theme tokens */}
            <button
              id="sign-out-btn"
              type="button"
              onClick={signOut}
              title="Sign out"
              aria-label="Sign out"
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] transition-all hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main content — pb-24 clears the fixed mobile bottom nav on small screens */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-24 sm:px-6 md:pb-8">
        {children}
      </main>

      {/* Mobile Bottom Tab Bar — 4 Primary tabs + 5th "More" popup menu */}
      <nav
        aria-label="Mobile navigation"
        className="fixed bottom-0 left-0 right-0 z-40 grid grid-cols-5 md:hidden border-t border-[var(--border)] bg-[var(--surface)]/95 px-1 pb-safe shadow-[var(--shadow-md)]"
        style={{ backdropFilter: 'blur(12px)' }}
      >
        {PRIMARY_NAV_ITEMS.map(item => {
          const Icon = item.icon
          const active = isRouteActive(location.pathname, item)
          return (
            <Link
              key={item.href}
              to={item.href}
              aria-current={active ? 'page' : undefined}
              className={`relative flex flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] font-medium transition-all ${
                active ? 'text-[var(--primary)] font-semibold' : 'text-[var(--text-muted)]'
              }`}
            >
              {active && (
                <span
                  className="absolute top-0 h-0.5 w-8 rounded-full bg-[var(--primary)]"
                  aria-hidden="true"
                />
              )}
              <Icon className={`h-5 w-5 ${active ? 'stroke-[2.5]' : 'stroke-2'}`} />
              <span className="truncate max-w-full px-1">{item.label}</span>
            </Link>
          )
        })}

        {/* 5th Tab: More Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              id="mobile-more-nav-btn"
              aria-label="More navigation options"
              className={`relative flex flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] font-medium transition-all outline-none cursor-pointer ${
                isSecondaryActive
                  ? 'text-[var(--primary)] font-semibold'
                  : 'text-[var(--text-muted)]'
              }`}
            >
              {isSecondaryActive && (
                <span
                  className="absolute top-0 h-0.5 w-8 rounded-full bg-[var(--primary)]"
                  aria-hidden="true"
                />
              )}
              {activeSecondaryItem ? (
                <>
                  <activeSecondaryItem.icon className="h-5 w-5 stroke-[2.5]" />
                  <span className="truncate max-w-full px-1">
                    {activeSecondaryItem.label}
                  </span>
                </>
              ) : (
                <>
                  <MoreHorizontal className="h-5 w-5 stroke-2" />
                  <span>More</span>
                </>
              )}
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            side="top"
            align="end"
            sideOffset={10}
            className="w-52 mr-2"
          >
            {SECONDARY_NAV_ITEMS.map(item => {
              const Icon = item.icon
              const active = isRouteActive(location.pathname, item)
              return (
                <div key={item.href}>
                  {item.separatorBefore && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    asChild
                    className={
                      active
                        ? 'bg-[var(--primary-muted)] text-[var(--primary)] font-semibold focus:bg-[var(--primary-muted)] focus:text-[var(--primary)]'
                        : ''
                    }
                  >
                    <Link
                      to={item.href}
                      aria-current={active ? 'page' : undefined}
                      className="flex w-full items-center justify-between py-2"
                    >
                      <span className="flex items-center gap-2.5">
                        <Icon className="h-4 w-4 shrink-0" />
                        <span>{item.label}</span>
                      </span>
                      {active && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-[var(--primary)]"
                          aria-hidden="true"
                        />
                      )}
                    </Link>
                  </DropdownMenuItem>
                </div>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </div>
  )
}

// Re-export logos for use elsewhere
export { logoMarkDark, logoMarkLight, logoFullDark, logoFullLight }
