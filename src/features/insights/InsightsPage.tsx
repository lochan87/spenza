import { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Cell, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { RefreshCw, Loader2, Lightbulb, TrendingUp, Hash, Repeat, ZapIcon, Star, Download } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { getCachedInsights, computeAndCacheInsights, isCacheFresh } from '@/services/insights'
import { getCategories, getPaymentAccounts } from '@/services/transactions'
import { exportTransactionsCSV } from '@/services/exportCsv'
import { formatINR, formatINRCompact } from '@/utils/format'
import { useTheme } from '@/hooks/useTheme'
import type { InsightsSummary, Category, PaymentAccount } from '@/types'

const currentYear = new Date().getFullYear()

interface InsightCardProps {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
  accentColor?: string
}

function InsightCard({ icon, label, value, sub, accentColor }: InsightCardProps) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      <div className="mb-2 flex items-center gap-2">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={accentColor
            ? { backgroundColor: accentColor + '20', color: accentColor }
            : { backgroundColor: 'var(--primary-muted)', color: 'var(--primary)' }}
        >
          {icon}
        </div>
        <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      </div>
      <p className="text-xl font-bold text-[var(--text-primary)]">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-[var(--text-subtle)]">{sub}</p>}
    </div>
  )
}

interface ChartTooltipProps {
  active?: boolean
  payload?: Array<{ value: number; payload: { year: number; totalPaise: number } }>
}

function ChartTooltip({ active, payload }: ChartTooltipProps) {
  if (!active || !payload?.length) return null
  const { year, totalPaise } = payload[0].payload
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-md)]">
      <p className="text-xs font-medium text-[var(--text-muted)]">
        {year}{year === currentYear ? ' (in progress)' : ''}
      </p>
      <p className="text-sm font-bold text-[var(--text-primary)]">{formatINR(totalPaise)}</p>
    </div>
  )
}

export function InsightsPage() {
  const { user } = useAuth()
  const { isDark } = useTheme()
  const [insights, setInsights] = useState<InsightsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [computing, setComputing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cacheAge, setCacheAge] = useState<string>('')
  const [categories, setCategories] = useState<Category[]>([])
  const [accounts, setAccounts] = useState<PaymentAccount[]>([])

  const primaryColor = isDark ? '#14B8A6' : '#0F766E'
  const gridColor    = isDark ? '#334155' : '#E2E8F0'
  const textColor    = isDark ? '#94A3B8' : '#64748B'

  const loadInsights = async (forceRefresh = false) => {
    if (!user) return
    setError(null)
    try {
      if (!forceRefresh) {
        const cached = await getCachedInsights(user.uid)
        if (cached && isCacheFresh(cached)) {
          setInsights(cached)
          const computed = cached.computedAt.toDate()
          setCacheAge(`Updated ${format(computed, 'd MMM, h:mm a')}`)
          setLoading(false)
          return
        }
      }
      // Need to compute
      setComputing(true)
      const fresh = await computeAndCacheInsights(user.uid)
      setInsights(fresh)
      setCacheAge(`Updated just now`)
    } catch (err) {
      console.error('[Spenza] Insights error:', err)
      setError('Failed to load insights.')
    } finally {
      setLoading(false)
      setComputing(false)
    }
  }

  useEffect(() => { loadInsights() }, [user])

  useEffect(() => {
    if (!user) return
    Promise.all([getCategories(user.uid), getPaymentAccounts(user.uid)])
      .then(([cats, accs]) => { setCategories(cats); setAccounts(accs) })
      .catch(console.error)
  }, [user])

  const handleExport = async () => {
    if (!user) return
    setExporting(true)
    try {
      await exportTransactionsCSV(user.uid, categories, accounts)
    } catch (err) {
      console.error('[Spenza] Export error:', err)
    } finally {
      setExporting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--primary)]" />
        <p className="text-sm text-[var(--text-muted)]">Loading insights…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-52 flex-col items-center justify-center gap-3">
        <p className="text-sm text-[var(--danger)]">{error}</p>
        <button onClick={() => loadInsights(true)}
          className="rounded-xl bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white">
          Retry
        </button>
      </div>
    )
  }

  if (!insights) {
    return (
      <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]">
        <Lightbulb className="h-8 w-8 text-[var(--text-subtle)]" />
        <p className="text-sm text-[var(--text-muted)]">No data yet — add some transactions first!</p>
      </div>
    )
  }

  const { yearlyTotals } = insights
  const highestYear = yearlyTotals.reduce<{ year: number; totalPaise: number } | null>(
    (best, y) => (!best || y.totalPaise > best.totalPaise ? y : best), null
  )

  return (
    <div className="flex flex-col gap-5 pb-20 md:pb-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Insights</h1>
          <p className="text-xs text-[var(--text-subtle)]">{cacheAge}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Export CSV
          </button>
          <button
            onClick={() => loadInsights(true)}
            disabled={computing}
            className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            {computing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </div>
      </div>

      {/* Year-over-year bar chart */}
      {yearlyTotals.length > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <div className="mb-1 flex items-start justify-between">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Year-over-Year Spending</h3>
              <p className="text-xs text-[var(--text-muted)]">* = current year (partial)</p>
            </div>
            {highestYear && (
              <span className="rounded-full bg-[var(--primary-muted)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary)]">
                Peak: {highestYear.year}
              </span>
            )}
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={yearlyTotals.map(y => ({ ...y, label: y.year === currentYear ? `${y.year}*` : String(y.year) }))}
              margin={{ top: 12, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
              <XAxis dataKey="label" tick={{ fill: textColor, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => formatINRCompact(v)} tick={{ fill: textColor, fontSize: 10 }}
                axisLine={false} tickLine={false} width={52} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="totalPaise" radius={[6, 6, 0, 0]}>
                {yearlyTotals.map((entry, i) => (
                  <Cell
                    key={`cell-${i}`}
                    fill={entry.year === currentYear ? primaryColor + '80' : primaryColor}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Auto-generated insight sentence */}
      {insights.highestYearInsight && (
        <div className="flex items-start gap-3 rounded-2xl border border-[var(--primary-muted)] bg-[var(--primary-muted)] p-4">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" />
          <p className="text-sm text-[var(--text-secondary)]">{insights.highestYearInsight}</p>
        </div>
      )}

      {/* Stat cards grid */}
      <div className="grid grid-cols-2 gap-3">
        {insights.highestSpendingMonth && (
          <InsightCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Highest month ever"
            value={formatINRCompact(insights.highestSpendingMonth.totalPaise)}
            sub={format(new Date(insights.highestSpendingMonth.monthKey + '-01'), 'MMMM yyyy')}
          />
        )}
        {insights.mostFrequentCategory && (
          <InsightCard
            icon={<Hash className="h-4 w-4" />}
            label="Most frequent category"
            value={insights.mostFrequentCategory.name}
            sub={`${insights.mostFrequentCategory.count} transactions`}
          />
        )}
        {insights.largestSingleExpense && (
          <InsightCard
            icon={<Star className="h-4 w-4" />}
            label="Largest single expense"
            value={formatINR(insights.largestSingleExpense.amountPaise)}
            sub={insights.largestSingleExpense.description}
            accentColor="#F59E0B"
          />
        )}
        {insights.mostFrequentSmallDesc && (
          <InsightCard
            icon={<Repeat className="h-4 w-4" />}
            label="Most repeated micro spend"
            value={insights.mostFrequentSmallDesc.description}
            sub={`${insights.mostFrequentSmallDesc.count}× under ₹100`}
          />
        )}
        <InsightCard
          icon={<ZapIcon className="h-4 w-4" />}
          label="Gifts & Events all-time"
          value={formatINR(insights.giftEventTotalPaise)}
          accentColor="#EC4899"
        />
        <InsightCard
          icon={<span className="text-base">✈️</span>}
          label="Trip spending all-time"
          value={formatINR(insights.tripTotalPaise)}
          accentColor="#06B6D4"
        />
      </div>
    </div>
  )
}
