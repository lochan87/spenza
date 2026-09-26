import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { useTheme } from '@/hooks/useTheme'
import { formatINRCompact, formatINR } from '@/utils/format'
import type { MonthlyTotal } from '../dashboardData'

interface TrendChartProps {
  monthlyTotals: MonthlyTotal[]
}

interface CustomDotProps {
  cx?: number
  cy?: number
  payload?: MonthlyTotal
  isOutlier?: boolean
  primaryColor: string
  dangerColor: string
}

function CustomDot({ cx = 0, cy = 0, payload, primaryColor, dangerColor }: CustomDotProps) {
  if (!payload) return null
  const color = payload.isOutlier ? dangerColor : primaryColor
  return (
    <g>
      <circle cx={cx} cy={cy} r={payload.isOutlier ? 7 : 4} fill={color} stroke="none" opacity={0.25} />
      <circle cx={cx} cy={cy} r={payload.isOutlier ? 4 : 3} fill={color} stroke="var(--surface)" strokeWidth={2} />
    </g>
  )
}

interface CustomTooltipProps {
  active?: boolean
  payload?: Array<{ value: number; payload: MonthlyTotal }>
  label?: string
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  const item = payload[0].payload as MonthlyTotal
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-md)]">
      <p className="text-xs font-medium text-[var(--text-muted)]">{item.monthLabel}</p>
      <p className="text-sm font-bold text-[var(--text-primary)]">{formatINR(item.totalPaise)}</p>
      {item.isOutlier && (
        <p className="mt-0.5 text-[10px] text-[var(--danger)] font-medium">⚠ Unusually high</p>
      )}
    </div>
  )
}

export function TrendChart({ monthlyTotals }: TrendChartProps) {
  const { isDark } = useTheme()

  // Theme-aware chart colors — from the exact palette spec
  const primaryColor = isDark ? '#14B8A6' : '#0F766E'
  const accentColor  = isDark ? '#38BDF8' : '#0284C7'
  const dangerColor  = isDark ? '#F87171' : '#DC2626'
  const gridColor    = isDark ? '#334155' : '#E2E8F0'
  const textColor    = isDark ? '#94A3B8' : '#64748B'

  // Compute average for reference line
  const avg = monthlyTotals.length
    ? monthlyTotals.reduce((s, m) => s + m.totalPaise, 0) / monthlyTotals.length
    : 0

  const hasData = monthlyTotals.some(m => m.totalPaise > 0)

  if (!hasData) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">6-Month Trend</h3>
        <div className="flex h-40 items-center justify-center text-sm text-[var(--text-subtle)]">
          Not enough data yet
        </div>
      </div>
    )
  }

  const outlierMonths = monthlyTotals.filter(m => m.isOutlier)

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">6-Month Trend</h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">Monthly spending pattern</p>
        </div>
        {outlierMonths.length > 0 && (
          <div className="flex items-center gap-1.5 rounded-full bg-[var(--danger-muted)] px-2.5 py-1 text-[10px] font-semibold text-[var(--danger)]">
            ⚠ {outlierMonths.map(m => m.monthLabel).join(', ')} unusually high
          </div>
        )}
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={monthlyTotals} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
          <XAxis
            dataKey="monthLabel"
            tick={{ fill: textColor, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={v => formatINRCompact(v)}
            tick={{ fill: textColor, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={52}
          />
          <Tooltip content={<CustomTooltip />} />

          {/* Average reference line */}
          {avg > 0 && (
            <ReferenceLine
              y={avg}
              stroke={accentColor}
              strokeDasharray="4 3"
              strokeOpacity={0.6}
              label={{
                value: `Avg ${formatINRCompact(avg)}`,
                position: 'insideTopRight',
                fill: accentColor,
                fontSize: 10,
              }}
            />
          )}

          <Line
            type="monotone"
            dataKey="totalPaise"
            stroke={primaryColor}
            strokeWidth={2.5}
            dot={(props) => (
              <CustomDot
                key={`dot-${props.index}`}
                {...props}
                primaryColor={primaryColor}
                dangerColor={dangerColor}
              />
            )}
            activeDot={{ r: 6, fill: primaryColor, stroke: 'var(--surface)', strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>

      <p className="mt-2 text-[10px] text-[var(--text-subtle)]">
        ⬤ Highlighted dots = months &gt;50% above the 6-month average
      </p>
    </div>
  )
}
