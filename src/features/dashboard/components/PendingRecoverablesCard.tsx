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
    peopleDues,
  } = data

  const peopleWithDues = (peopleDues || []).filter(p => p.pendingDuesPaise > 0)

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

      {/* People breakdown */}
      {peopleWithDues.length > 0 && (
        <div className="mt-4 border-t border-[var(--border)] pt-3.5">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Who Owes You ({peopleWithDues.length})
            </span>
            <span className="text-[10px] text-[var(--text-subtle)]">
              Click to view bills
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {peopleWithDues.slice(0, 4).map(p => (
              <div
                key={p.personId}
                onClick={() =>
                  navigate(
                    `/app/transactions?filter=pending_dues&person=${encodeURIComponent(
                      p.personName
                    )}`
                  )
                }
                className="flex cursor-pointer items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/60 px-3 py-2 transition-all hover:bg-[var(--surface-2)] active:scale-[0.99]"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--warning-muted)] text-[10px] font-bold text-[var(--warning)]">
                    {p.personName.charAt(0).toUpperCase()}
                  </div>
                  <div className="truncate">
                    <span className="text-xs font-semibold text-[var(--text-primary)] truncate">
                      {p.personName}
                    </span>
                    <span className="ml-1 text-[10px] text-[var(--text-subtle)]">
                      · {p.unsettledTxnCount} {p.unsettledTxnCount === 1 ? 'bill' : 'bills'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-xs font-bold text-[var(--warning)]">
                    {formatINR(p.pendingDuesPaise)}
                  </span>
                  <ChevronRight className="h-3 w-3 text-[var(--text-subtle)]" />
                </div>
              </div>
            ))}
          </div>
          {peopleWithDues.length > 4 && (
            <button
              onClick={() => navigate('/app/transactions?filter=pending_dues')}
              className="mt-2 text-[11px] font-medium text-[var(--primary)] hover:underline"
            >
              + {peopleWithDues.length - 4} more people with pending dues
            </button>
          )}
        </div>
      )}
    </div>
  )
}
