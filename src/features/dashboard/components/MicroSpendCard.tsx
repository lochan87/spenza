import { Zap } from 'lucide-react'
import { formatINR, formatINRCompact } from '@/utils/format'
import type { DashboardData } from '../dashboardData'

interface MicroSpendCardProps {
  data: DashboardData
}

export function MicroSpendCard({ data }: MicroSpendCardProps) {
  const { microCount, microTotal, microAvg } = data

  if (microCount === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-1 text-sm font-semibold text-[var(--text-primary)]">Micro Spending</h3>
        <p className="text-sm text-[var(--text-muted)]">No transactions under ₹100 this month.</p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      <div className="mb-3 flex items-center gap-2">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{ backgroundColor: 'var(--warning-muted)', color: 'var(--warning)' }}
        >
          <Zap className="h-4 w-4" />
        </div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Micro Spending</h3>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <p className="text-xs text-[var(--text-muted)]">Count</p>
          <p className="text-lg font-bold text-[var(--text-primary)]">{microCount}</p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">Total</p>
          <p className="text-lg font-bold text-[var(--text-primary)]">{formatINRCompact(microTotal)}</p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">Avg</p>
          <p className="text-lg font-bold text-[var(--text-primary)]">{formatINRCompact(microAvg)}</p>
        </div>
      </div>

      {/* Insight line */}
      <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2.5">
        <p className="text-xs text-[var(--text-secondary)]">
          💡 Your ₹20–₹100 purchases added up to{' '}
          <strong className="text-[var(--text-primary)]">{formatINR(microTotal)}</strong>{' '}
          this month across <strong>{microCount}</strong> transactions.
        </p>
      </div>
    </div>
  )
}
