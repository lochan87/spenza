import { Users, Clock, CheckCircle2, ChevronRight, ArrowUpRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { formatINR, formatINRCompact } from '@/utils/format'
import type { DashboardData } from '../dashboardData'

interface PendingRecoverablesCardProps {
  data: DashboardData
}

export function PendingRecoverablesCard({ data }: PendingRecoverablesCardProps) {
  const navigate = useNavigate()
  const {
    allTimePendingDuesTotal,
    thisMonthRecoverableTotal,
    thisMonthRepaidTotal,
  } = data

  // Hide card if there are no pending dues and nothing was fronted or repaid this month
  if (
    allTimePendingDuesTotal === 0 &&
    thisMonthRecoverableTotal === 0 &&
    thisMonthRepaidTotal === 0
  ) {
    return null
  }

  const hasPending = allTimePendingDuesTotal > 0

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-xl"
            style={{
              backgroundColor: hasPending
                ? 'var(--warning-muted)'
                : 'var(--success-muted)',
              color: hasPending ? 'var(--warning)' : 'var(--success)',
            }}
          >
            <Users className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Split Bills & Recoverables
            </h3>
            <p className="text-[11px] text-[var(--text-muted)]">
              Money fronted for friends and shared expenses
            </p>
          </div>
        </div>

        <button
          onClick={() => navigate('/app/transactions?filter=pending_dues')}
          className="flex items-center gap-1 text-xs font-medium text-[var(--primary)] hover:underline"
        >
          View ledger
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>

      {/* Grid of 3 stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Outstanding Dues */}
        <div className="flex flex-col justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-muted)]">
              Outstanding Dues
            </span>
            {hasPending ? (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-[var(--warning)]">
                <Clock className="h-3 w-3" />
                Pending
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-[var(--success)]">
                <CheckCircle2 className="h-3 w-3" />
                All settled
              </span>
            )}
          </div>
          <p
            className="mt-2 text-xl font-extrabold tracking-tight"
            style={{
              color: hasPending ? 'var(--warning)' : 'var(--success)',
            }}
          >
            {formatINR(allTimePendingDuesTotal)}
          </p>
          <p className="mt-0.5 text-[10px] text-[var(--text-subtle)]">
            {hasPending ? 'Total amount owed to you' : 'No pending dues'}
          </p>
        </div>

        {/* Fronted This Month */}
        <div className="flex flex-col justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-muted)]">
              Fronted this Month
            </span>
            <ArrowUpRight className="h-3 w-3 text-[var(--text-subtle)]" />
          </div>
          <p className="mt-2 text-xl font-bold text-[var(--text-primary)]">
            {formatINRCompact(thisMonthRecoverableTotal)}
          </p>
          <p className="mt-0.5 text-[10px] text-[var(--text-subtle)]">
            Others' shares (excluded from spend)
          </p>
        </div>

        {/* Repaid This Month */}
        <div className="flex flex-col justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-muted)]">
              Repaid this Month
            </span>
            <CheckCircle2 className="h-3 w-3 text-[var(--text-subtle)]" />
          </div>
          <p className="mt-2 text-xl font-bold text-[var(--text-primary)]">
            {formatINRCompact(thisMonthRepaidTotal)}
          </p>
          <p className="mt-0.5 text-[10px] text-[var(--text-subtle)]">
            Received back into accounts
          </p>
        </div>
      </div>
    </div>
  )
}
