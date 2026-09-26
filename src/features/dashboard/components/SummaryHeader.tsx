import { format } from 'date-fns'
import { TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { formatINR, formatPct, getGreeting } from '@/utils/format'
import type { DashboardData } from '../dashboardData'

interface SummaryHeaderProps {
  data: DashboardData
}

export function SummaryHeader({ data }: SummaryHeaderProps) {
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

      {/* Greeting */}
      <p className="mb-1 text-sm font-medium text-[var(--text-muted)]">
        {getGreeting()}, {firstName} · {monthName}
      </p>

      {/* Big total */}
      <p className="text-4xl font-extrabold tracking-tight text-[var(--text-primary)]">
        {formatINR(thisMonthTotal)}
      </p>
      <p className="mt-0.5 text-sm text-[var(--text-muted)]">spent this month</p>

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
