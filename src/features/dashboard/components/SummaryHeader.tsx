import { format } from 'date-fns'
import { TrendingDown, TrendingUp, Minus, WifiOff, RefreshCw } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { formatINR, formatPct, getGreeting } from '@/utils/format'
import type { DashboardData } from '../dashboardData'

interface SummaryHeaderProps {
  data: DashboardData
  isStale?: boolean
  isFromCache?: boolean
  isOffline?: boolean
}

export function SummaryHeader({ data, isStale, isFromCache, isOffline }: SummaryHeaderProps) {
  const { user } = useAuth()
  const firstName = user?.displayName?.split(' ')[0] ?? 'there'
  const monthName = format(new Date(), 'MMMM yyyy')

  const { thisMonthTotal, lastMonthTotal, pctChange } = data

  // Color + icon for % change
  const pctDown = pctChange !== null && pctChange < 0
  const pctUp = pctChange !== null && pctChange > 0

  return (
    <div className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-sm)]">
      {/* Background gradient accent */}
      <div
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-[0.06]"
        style={{ background: 'radial-gradient(circle, var(--primary), transparent)' }}
        aria-hidden
      />

      {/* Greeting and Sync Status */}
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-[var(--text-muted)]">
          {getGreeting()}, {firstName} · {monthName}
        </p>
        {isStale ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--warning-muted)] px-2 py-0.5 text-xs font-medium text-[var(--warning)]">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Updating balances…
          </span>
        ) : (isOffline || isFromCache) ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-[var(--warning-muted)] px-2 py-0.5 text-xs font-medium text-[var(--warning)]"
            title="Balances reflect local offline cache. Fresh data will sync when online."
          >
            <WifiOff className="h-3 w-3" />
            Cached offline balances
          </span>
        ) : null}
      </div>

      {/* Big total */}
      <p className="text-4xl font-extrabold tracking-tight text-[var(--text-primary)]">
        {formatINR(thisMonthTotal)}
      </p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-sm text-[var(--text-muted)]">spent this month</p>
        {data.thisMonthGrossOutflow > thisMonthTotal && (
          <span className="text-xs text-[var(--text-subtle)]">
            · {formatINR(data.thisMonthGrossOutflow)} total outflow
          </span>
        )}
      </div>

      {/* % change vs last month */}
      <div className="mt-3 flex items-center gap-2">
        {pctChange === null ? (
          <span className="flex items-center gap-1 text-sm text-[var(--text-subtle)]">
            <Minus className="h-4 w-4" />
            No data from last month
          </span>
        ) : pctDown ? (
          <span className="flex items-center gap-1.5 rounded-full bg-[var(--success-muted)] px-3 py-1 text-sm font-semibold text-[var(--success)]">
            <TrendingDown className="h-4 w-4" />
            {formatPct(pctChange)} vs last month
          </span>
        ) : pctUp ? (
          <span
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold"
            style={{
              // Amber for moderate increase, danger for >50% jump
              backgroundColor: pctChange > 50 ? 'var(--danger-muted)' : 'var(--warning-muted)',
              color: pctChange > 50 ? 'var(--danger)' : 'var(--warning)',
            }}
          >
            <TrendingUp className="h-4 w-4" />
            {formatPct(pctChange)} vs last month
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full bg-[var(--surface-2)] px-3 py-1 text-sm text-[var(--text-muted)]">
            <Minus className="h-4 w-4" />
            Same as last month
          </span>
        )}

        {/* Last month reference */}
        {lastMonthTotal > 0 && (
          <span className="text-xs text-[var(--text-subtle)]">
            (last: {formatINR(lastMonthTotal)})
          </span>
        )}
      </div>
    </div>
  )
}
