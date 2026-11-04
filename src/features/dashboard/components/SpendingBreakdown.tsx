import { formatINR, formatINRCompact } from '@/utils/format'
import type { DashboardData } from '../dashboardData'

interface SpendingBreakdownProps {
  data: DashboardData
}

interface TypeRow {
  label: string
  total: number
  badgeClass: string
}

export function SpendingBreakdown({ data }: SpendingBreakdownProps) {
  const {
    thisMonthTotal,
    normalSpendTotal,
    everydayTotal,
    recurringTotal,
    oneTimeTotal,
    tripTotal,
    giftEventTotal,
    reimbursableTotal,
  } = data

  const types: TypeRow[] = [
    {
      label: 'Everyday + Recurring',
      total: everydayTotal + recurringTotal,
      badgeClass: 'badge-everyday',
    },
    {
      label: 'One-time',
      total: oneTimeTotal,
      badgeClass: 'badge-one-time',
    },
    {
      label: 'Trips',
      total: tripTotal,
      badgeClass: 'badge-trip',
    },
    {
      label: 'Gift & Events',
      total: giftEventTotal,
      badgeClass: 'badge-gift-event',
    },
    ...(reimbursableTotal > 0
      ? [{
          label: 'Reimbursable',
          total: reimbursableTotal,
          badgeClass: 'badge-reimbursable',
        }]
      : []),
  ].filter(t => t.total > 0)

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      <h3 className="mb-1 text-sm font-semibold text-[var(--text-primary)]">
        Spending Breakdown
      </h3>
      <p className="mb-4 text-xs text-[var(--text-muted)]">Where your money went this month</p>

      {/* Stacked bar */}
      {thisMonthTotal > 0 && (
        <div className="mb-4 flex h-3 w-full overflow-hidden rounded-full">
          {types.map(({ label, total, badgeClass }) => {
            const pct = (total / thisMonthTotal) * 100
            if (pct < 0.5) return null
            return (
              <div
                key={label}
                title={`${label}: ${formatINR(total)}`}
                className={`h-full ${badgeClass} transition-all`}
                style={{ width: `${pct}%` }}
              />
            )
          })}
        </div>
      )}

      {/* Rows */}
      <div className="flex flex-col gap-2">
        {types.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No transactions this month yet.</p>
        ) : (
          types.map(({ label, total, badgeClass }) => {
            const pct = thisMonthTotal > 0 ? (total / thisMonthTotal) * 100 : 0
            return (
              <div key={label} className="flex items-center gap-3">
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${badgeClass}`}>
                  {label}
                </span>
                {/* Bar */}
                <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-2)]">
                  <div
                    className={`h-full rounded-full ${badgeClass} opacity-70`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="shrink-0 text-sm font-semibold text-[var(--text-primary)]">
                  {formatINRCompact(total)}
                </span>
              </div>
            )
          })
        )}
      </div>

      {/* Normal spend callout */}
      <div className="mt-4 flex items-center justify-between rounded-xl border border-[var(--primary-muted)] bg-[var(--primary-muted)] px-4 py-3">
        <div>
          <p className="text-xs font-medium text-[var(--text-muted)]">
            Your normal monthly spending
          </p>
          <p className="text-[10px] text-[var(--text-subtle)]">
            Everyday + Recurring only — excludes one-time, trips, gifts
          </p>
        </div>
        <p className="text-lg font-extrabold text-[var(--primary)]">
          {formatINR(normalSpendTotal)}
        </p>
      </div>

      {/* Recoverables callout */}
      {data.thisMonthRecoverableTotal > 0 && (
        <div className="mt-2.5 flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
          <div>
            <p className="text-xs font-medium text-[var(--text-primary)]">
              Fronted for others this month
            </p>
            <p className="text-[10px] text-[var(--text-subtle)]">
              Recoverable shares excluded from personal spend
            </p>
          </div>
          <p className="text-sm font-bold text-[var(--text-muted)]">
            {formatINR(data.thisMonthRecoverableTotal)}
          </p>
        </div>
      )}
    </div>
  )
}
