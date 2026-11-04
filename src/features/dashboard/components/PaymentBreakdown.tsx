import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { getPaymentMeta, getAccountTypeMeta } from '@/utils/paymentColors'
import { formatINR, formatINRCompact } from '@/utils/format'
import type { PaymentModeTotal, AccountTotal } from '../dashboardData'

interface PaymentBreakdownProps {
  paymentModeTotals: PaymentModeTotal[]
  accountTotals: AccountTotal[]
  totalThisMonth: number
  totalGrossOutflow?: number
}

interface CustomTooltipProps {
  active?: boolean
  payload?: Array<{ name: string; value: number; payload: PaymentModeTotal }>
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  const item = payload[0].payload
  const meta = getPaymentMeta(item.mode)
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-md)]">
      <p className="text-xs font-medium" style={{ color: meta.color }}>{item.mode}</p>
      <p className="text-sm font-bold text-[var(--text-primary)]">{formatINR(item.totalPaise)}</p>
    </div>
  )
}

export function PaymentBreakdown({
  paymentModeTotals,
  accountTotals,
  totalThisMonth,
  totalGrossOutflow,
}: PaymentBreakdownProps) {

  if (paymentModeTotals.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Payment Breakdown</h3>
        <p className="text-sm text-[var(--text-muted)]">No data yet.</p>
      </div>
    )
  }

  // Base for gross percentage calculations (defaults to gross outflow if provided, else sum of modes or total)
  const baseGross = totalGrossOutflow ?? (
    paymentModeTotals.reduce((s, m) => s + m.totalPaise, 0) || totalThisMonth
  )

  // Chart data
  const chartData = paymentModeTotals.map(m => ({
    ...m,
    name: m.mode,
    value: m.totalPaise,
    fill: getPaymentMeta(m.mode).color,
  }))

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      <h3 className="mb-4 text-sm font-semibold text-[var(--text-primary)]">
        Payment Mode Breakdown
      </h3>

      {/* Donut + legend row */}
      <div className="flex items-center gap-4">
        {/* Donut */}
        <div className="shrink-0">
          <ResponsiveContainer width={120} height={120}>
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                innerRadius={36}
                outerRadius={56}
                dataKey="value"
                strokeWidth={0}
              >
                {chartData.map((entry, i) => (
                  <Cell key={`cell-${i}`} fill={entry.fill} opacity={0.9} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Legend */}
        <div className="flex-1 flex flex-col gap-1.5">
          {paymentModeTotals.map(({ mode, totalPaise }) => {
            const meta = getPaymentMeta(mode)
            const pct = baseGross > 0 ? (totalPaise / baseGross) * 100 : 0
            return (
              <div key={mode} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: meta.color }}
                  />
                  <span className="truncate text-xs text-[var(--text-muted)]">{mode}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-[var(--text-subtle)]">{pct.toFixed(0)}%</span>
                  <span className="text-xs font-semibold text-[var(--text-primary)]">
                    {formatINRCompact(totalPaise)}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Account breakdown — UPI/Bank/Card only */}
      {accountTotals.length > 0 && (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <p className="mb-3 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">
            By Account (UPI · Bank · Card)
          </p>
          <div className="flex flex-col gap-2">
            {accountTotals.map(({ accountId, accountName, accountType, totalPaise }) => {
              const meta = getAccountTypeMeta(accountType)
              const pct = baseGross > 0 ? (totalPaise / baseGross) * 100 : 0
              return (
                <div key={accountId} className="flex items-center gap-2">
                  <div
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[9px] font-bold"
                    style={{ backgroundColor: meta.bgColor, color: meta.color }}
                  >
                    {accountType.slice(0, 1)}
                  </div>
                  <span className="flex-1 truncate text-sm text-[var(--text-primary)]">
                    {accountName}
                  </span>
                  <span className="text-[10px] text-[var(--text-subtle)]">{pct.toFixed(0)}%</span>
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {formatINRCompact(totalPaise)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
