import { Receipt, TrendingDown, CalendarDays } from 'lucide-react'
import { formatINRCompact } from '@/utils/format'
import { getCategoryMeta } from '@/utils/categoryColors'
import type { DashboardData } from '../dashboardData'

interface QuickStatsRowProps {
  data: DashboardData
}

interface StatCardProps {
  label: string
  value: string
  icon: React.ReactNode
  accent?: boolean
  subtext?: string
}

function StatCard({ label, value, icon, accent, subtext }: StatCardProps) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={
            accent
              ? { backgroundColor: 'var(--primary-muted)', color: 'var(--primary)' }
              : { backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)' }
          }
        >
          {icon}
        </span>
      </div>
      <p className="text-xl font-bold text-[var(--text-primary)]">{value}</p>
      {subtext && <p className="text-xs text-[var(--text-subtle)]">{subtext}</p>}
    </div>
  )
}

export function QuickStatsRow({ data }: QuickStatsRowProps) {
  const { thisMonthTotal, txnCount, avgPerDay, topCategoryName } = data
  const catMeta = getCategoryMeta(topCategoryName)

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="Total this month"
        value={formatINRCompact(thisMonthTotal)}
        icon={<TrendingDown className="h-3.5 w-3.5" />}
        accent
      />
      <StatCard
        label="Transactions"
        value={txnCount.toString()}
        icon={<Receipt className="h-3.5 w-3.5" />}
        subtext="this month"
      />
      <StatCard
        label="Avg per day"
        value={formatINRCompact(avgPerDay)}
        icon={<CalendarDays className="h-3.5 w-3.5" />}
        subtext="so far"
      />
      <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-[var(--text-muted)]">Top category</span>
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg text-sm"
            style={{ backgroundColor: catMeta.color + '22' }}
          >
            {catMeta.emoji}
          </span>
        </div>
        <p className="text-base font-bold text-[var(--text-primary)] truncate">
          {topCategoryName === '—' ? 'None yet' : topCategoryName}
        </p>
        <p className="text-xs text-[var(--text-subtle)]">highest spend</p>
      </div>
    </div>
  )
}
