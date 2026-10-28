import { useState, useEffect } from 'react'
import { format, getDaysInMonth, parseISO } from 'date-fns'
import { Link } from 'react-router-dom'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ResponsiveContainer,
} from 'recharts'
import {
  RefreshCw,
  Loader2,
  Lightbulb,
  TrendingUp,
  TrendingDown,
  Hash,
  Repeat,
  ZapIcon,
  Star,
  Calendar,
  Flame,
  CreditCard,
  Gauge,
  ArrowUpRight,
  ArrowDownRight,
  Award,
  Scale,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import {
  getCachedInsights,
  computeAndCacheInsights,
  isCacheFresh,
  getLiveTransactionCount,
  getCurrentMonthSpendTotal,
  isCacheStaleAgainstCount,
} from '@/services/insights'
import { getCurrentBudget } from '@/services/budgets'
import { formatINR, formatINRCompact } from '@/utils/format'
import { getCategoryMeta, getCategoryColor } from '@/utils/categoryColors'
import { getPaymentColor } from '@/utils/paymentColors'
import { useTheme } from '@/hooks/useTheme'
import { ThemedSelect } from '@/components/ui/ThemedSelect'
import type {
  InsightsSummary,
  MonthlyTrendPoint,
  DayOfWeekItem,
  Budget,
} from '@/types'

const currentYear = new Date().getFullYear()

// ─── Stat Card Component ──────────────────────────────────────────────────────

interface InsightCardProps {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
  badge?: string
  accentColor?: string
  accentBg?: string
}

function InsightCard({
  icon,
  label,
  value,
  sub,
  badge,
  accentColor,
  accentBg,
}: InsightCardProps) {
  const resolvedColor = accentColor ?? 'var(--primary)'
  const resolvedBg =
    accentBg ??
    (accentColor
      ? `color-mix(in srgb, ${accentColor} 15%, transparent)`
      : 'var(--primary-muted)')

  return (
    <div className="flex flex-col justify-between rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]">
      <div>
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style={{ backgroundColor: resolvedBg, color: resolvedColor }}
            >
              {icon}
            </div>
            <span className="truncate text-xs font-medium text-[var(--text-muted)]">
              {label}
            </span>
          </div>
          {badge && (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ backgroundColor: resolvedBg, color: resolvedColor }}
            >
              {badge}
            </span>
          )}
        </div>
        <p className="truncate text-lg font-bold text-[var(--text-primary)]">{value}</p>
      </div>
      {sub && <p className="mt-1 truncate text-xs text-[var(--text-subtle)]">{sub}</p>}
    </div>
  )
}

// ─── Tooltips ─────────────────────────────────────────────────────────────────

function YoYChartTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ value: number; payload: { year: number; totalPaise: number } }>
}) {
  if (!active || !payload?.length) return null
  const { year, totalPaise } = payload[0].payload
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-md)]">
      <p className="text-xs font-medium text-[var(--text-muted)]">
        {year}
        {year === currentYear ? ' (in progress)' : ''}
      </p>
      <p className="text-sm font-bold text-[var(--text-primary)]">{formatINR(totalPaise)}</p>
    </div>
  )
}

function MonthlyTrendTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: MonthlyTrendPoint }>
}) {
  if (!active || !payload?.length) return null
  const pt = payload[0].payload
  return (
    <div className="min-w-[180px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lg)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-[var(--text-primary)]">
          {pt.fullLabel}
          {pt.isCurrentMonth ? ' (in progress)' : ''}
        </p>
        {pt.isOutlier && (
          <span className="rounded-full bg-[var(--warning-muted)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--warning)]">
            Spike
          </span>
        )}
      </div>
      <p className="mt-1 text-base font-bold text-[var(--primary)]">
        {formatINR(pt.totalPaise)}
      </p>
      <div className="mt-1.5 flex flex-col gap-0.5 border-t border-[var(--border)] pt-1.5 text-[11px]">
        {pt.pctChangeVsPrev !== null ? (
          <p
            className={
              pt.pctChangeVsPrev > 0
                ? 'text-[var(--danger)]'
                : pt.pctChangeVsPrev < 0
                ? 'text-[var(--success)]'
                : 'text-[var(--text-muted)]'
            }
          >
            {pt.pctChangeVsPrev > 0 ? '+' : ''}
            {pt.pctChangeVsPrev}% vs previous month
          </p>
        ) : (
          <p className="text-[var(--text-subtle)]">No prior month baseline</p>
        )}
        {pt.topCategoryName && pt.topCategoryPaise > 0 && (
          <p className="text-[var(--text-muted)]">
            Top: <strong className="text-[var(--text-primary)]">{pt.topCategoryName}</strong> (
            {formatINRCompact(pt.topCategoryPaise)})
          </p>
        )}
      </div>
    </div>
  )
}

function CategoryTrendTooltip({
  active,
  payload,
  categoryName,
  categoryEmoji,
  categoryColor,
}: {
  active?: boolean
  payload?: Array<{
    value: number
    payload: { label: string; totalPaise: number; isCurrentMonth: boolean }
  }>
  categoryName: string
  categoryEmoji: string
  categoryColor: string
}) {
  if (!active || !payload?.length) return null
  const pt = payload[0].payload
  return (
    <div className="min-w-[155px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 shadow-[var(--shadow-lg)]">
      <p className="text-xs font-semibold text-[var(--text-primary)]">
        {pt.label}
        {pt.isCurrentMonth ? ' (in progress)' : ''}
      </p>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: categoryColor }}
          />
          {categoryEmoji} {categoryName}
        </span>
        <span className="text-xs font-bold text-[var(--text-primary)]">
          {formatINR(pt.totalPaise)}
        </span>
      </div>
    </div>
  )
}

function DayOfWeekTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: DayOfWeekItem }>
}) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="min-w-[180px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 shadow-[var(--shadow-lg)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-[var(--text-primary)]">{d.fullName}</p>
        {d.isWeekend && (
          <span className="rounded-full bg-[var(--accent-muted)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--accent)]">
            Weekend
          </span>
        )}
      </div>
      <p className="mt-1 text-sm font-bold text-[var(--primary)]">
        Avg {formatINR(d.avgPerOccurrencePaise)}/day
      </p>
      <div className="mt-1.5 flex flex-col gap-0.5 border-t border-[var(--border)] pt-1.5 text-[11px] text-[var(--text-secondary)]">
        <p>
          Total: <strong className="text-[var(--text-primary)]">{formatINRCompact(d.totalPaise)}</strong>{' '}
          ({d.txCount} {d.txCount === 1 ? 'txn' : 'txns'})
        </p>
        {d.topCategoryName && (
          <p>
            Top: <strong className="text-[var(--text-primary)]">{d.topCategoryName}</strong>
          </p>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function readCssThemeTokens() {
  if (typeof window === 'undefined') {
    return {
      primaryColor: 'var(--primary)',
      accentColor: 'var(--accent)',
      warningColor: 'var(--warning)',
      gridColor: 'var(--border)',
      textColor: 'var(--text-muted)',
    }
  }
  const style = getComputedStyle(document.documentElement)
  return {
    primaryColor: style.getPropertyValue('--primary').trim() || 'var(--primary)',
    accentColor: style.getPropertyValue('--accent').trim() || 'var(--accent)',
    warningColor: style.getPropertyValue('--warning').trim() || 'var(--warning)',
    gridColor: style.getPropertyValue('--border').trim() || 'var(--border)',
    textColor: style.getPropertyValue('--text-muted').trim() || 'var(--text-muted)',
  }
}

export function InsightsPage() {
  const { user } = useAuth()
  const { isDark } = useTheme()
  const [insights, setInsights] = useState<InsightsSummary | null>(null)
  const [currentBudget, setCurrentBudget] = useState<Budget | null>(null)
  const [liveCurrentMonthPaise, setLiveCurrentMonthPaise] = useState<number>(0)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [computing, setComputing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cacheAge, setCacheAge] = useState<string>('')
  const [themeColors, setThemeColors] = useState(readCssThemeTokens)

  // Re-read computed CSS custom properties whenever light/dark theme toggles
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setThemeColors(readCssThemeTokens())
    })
    return () => cancelAnimationFrame(frame)
  }, [isDark])

  const { primaryColor, accentColor, warningColor, gridColor, textColor } = themeColors

  const loadInsights = async (forceRefresh = false) => {
    if (!user) return
    setError(null)
    setLoading(true)
    try {
      const budgetPromise = getCurrentBudget(user.uid).catch(() => null)
      const currentMonthSpendPromise = getCurrentMonthSpendTotal(user.uid).catch(() => 0)

      if (!forceRefresh) {
        const [cached, liveCount, budgetDoc, monthSpendPaise] = await Promise.all([
          getCachedInsights(user.uid),
          getLiveTransactionCount(user.uid),
          budgetPromise,
          currentMonthSpendPromise,
        ])
        setCurrentBudget(budgetDoc)
        setLiveCurrentMonthPaise(monthSpendPaise)

        if (
          cached &&
          isCacheFresh(cached) &&
          !isCacheStaleAgainstCount(cached, liveCount)
        ) {
          setInsights(cached)
          if (cached.categoryMonthlyTrends?.length && !selectedCategoryId) {
            setSelectedCategoryId(cached.categoryMonthlyTrends[0].categoryId)
          }
          const computed = (cached.computedAt as any).toDate
            ? (cached.computedAt as any).toDate()
            : new Date()
          setCacheAge(`Updated ${format(computed, 'd MMM, h:mm a')}`)
          setLoading(false)
          return
        }
      } else {
        const [budgetDoc, monthSpendPaise] = await Promise.all([
          budgetPromise,
          currentMonthSpendPromise,
        ])
        setCurrentBudget(budgetDoc)
        setLiveCurrentMonthPaise(monthSpendPaise)
      }

      // Compute fresh summary
      setComputing(true)
      const fresh = await computeAndCacheInsights(user.uid)
      if (fresh === null) {
        setInsights(null)
        setError('not-enough-data')
      } else {
        setInsights(fresh)
        if (fresh.categoryMonthlyTrends?.length) {
          setSelectedCategoryId(prev =>
            prev && fresh.categoryMonthlyTrends!.some(c => c.categoryId === prev)
              ? prev
              : fresh.categoryMonthlyTrends![0].categoryId
          )
        }
        setCacheAge('Updated just now')
      }
    } catch (err: any) {
      console.error('[Spenza] Insights error:', err)
      if (err?.code === 'permission-denied') {
        setError('Permission denied — check Firestore rules for the insights collection.')
      } else {
        setError('Failed to load insights. Please try again.')
      }
    } finally {
      setLoading(false)
      setComputing(false)
    }
  }

  useEffect(() => {
    loadInsights()
  }, [user])

  if (loading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--primary)]" />
        <p className="text-sm text-[var(--text-muted)]">
          {computing ? 'Analyzing your spending patterns…' : 'Loading insights…'}
        </p>
      </div>
    )
  }

  if (error === 'not-enough-data') {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
        <Lightbulb className="h-10 w-10 text-[var(--text-subtle)]" />
        <div>
          <p className="font-medium text-[var(--text-primary)]">Not enough data yet</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Add at least 3 expenses first — insights become meaningful once you have a few transactions logged.
          </p>
        </div>
        <button
          onClick={() => loadInsights(true)}
          disabled={computing}
          className="flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {computing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Try again
        </button>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-2xl border border-[var(--danger-muted)] bg-[var(--surface)] p-6 text-center">
        <p className="text-sm font-medium text-[var(--danger)]">{error}</p>
        <button
          onClick={() => loadInsights(true)}
          disabled={computing}
          className="flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {computing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
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

  const {
    yearlyTotals,
    monthlyTrend = [],
    monthComparison,
    categoryMonthlyTrends = [],
    dayOfWeekStats,
    highestSpendingDay,
    longestStreak,
    avgTransactionSize,
    mostExpensiveCategory,
    paymentModeInsight,
    insightSentences = [],
  } = insights

  const highestYear = yearlyTotals.reduce<{ year: number; totalPaise: number } | null>(
    (best, y) => (!best || y.totalPaise > best.totalPaise ? y : best),
    null
  )

  // Prepare 12-month line chart data: split solid (completed) vs dashed (current month segment)
  const lastIdx = monthlyTrend.length - 1
  const hasCurrentMonthAtEnd = lastIdx >= 1 && monthlyTrend[lastIdx]?.isCurrentMonth
  const monthlyChartData = monthlyTrend.map((pt, idx) => {
    const displayLabel = pt.isCurrentMonth ? `${pt.label.split(' ')[0]}*` : pt.label
    if (!hasCurrentMonthAtEnd) {
      return {
        ...pt,
        displayLabel,
        solidPaise: pt.totalPaise,
        dashedPaise: null as number | null,
      }
    }
    return {
      ...pt,
      displayLabel,
      solidPaise: idx < lastIdx ? pt.totalPaise : null,
      dashedPaise: idx >= lastIdx - 1 ? pt.totalPaise : null,
    }
  })

  const outlierMonths = monthlyTrend.filter(m => m.isOutlier)

  // Selected category for Section 3
  const activeCatTrend =
    categoryMonthlyTrends.find(c => c.categoryId === selectedCategoryId) ??
    categoryMonthlyTrends[0] ??
    null
  const activeCatMeta = activeCatTrend ? getCategoryMeta(activeCatTrend.name) : null

  // Section 5: Current Month Spending Velocity / Pace (uses live query of this month's transactions)
  const now = new Date()
  const daysElapsed = Math.max(1, now.getDate())
  const daysInMonth = getDaysInMonth(now)
  const hasEnoughDaysForPace = daysElapsed >= 3
  const spentThisMonthPaise = liveCurrentMonthPaise
  const dailyPacePaise = Math.round(spentThisMonthPaise / daysElapsed)
  const projectedMonthEndPaise = hasEnoughDaysForPace
    ? Math.round(dailyPacePaise * daysInMonth)
    : null

  const effectiveBudgetPaise =
    currentBudget?.totalBudgetPaise ??
    (currentBudget?.categoryBudgets
      ? Object.values(currentBudget.categoryBudgets).reduce((s, v) => s + v, 0)
      : 0)
  const hasActiveBudget = effectiveBudgetPaise > 0
  const projectedBudgetDiffPaise =
    hasActiveBudget && projectedMonthEndPaise !== null
      ? projectedMonthEndPaise - effectiveBudgetPaise
      : null

  return (
    <div className="flex flex-col gap-5 pb-20 md:pb-8">
      {/* ── HEADER ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Insights</h1>
          <p className="text-xs text-[var(--text-subtle)]">{cacheAge}</p>
        </div>
        <button
          onClick={() => loadInsights(true)}
          disabled={computing}
          className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:opacity-50 cursor-pointer"
        >
          {computing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
      </div>

      {/* ── SECTION 7: SYNTHESIZED KEY TAKEAWAYS (2-3 Sentences) ── */}
      {(insightSentences.length > 0 || insights.highestYearInsight) && (
        <div className="rounded-2xl border border-[var(--primary-muted)] bg-[var(--primary-muted)] p-4">
          <div className="mb-2 flex items-center gap-2">
            <Lightbulb className="h-4 w-4 shrink-0 text-[var(--primary)]" />
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--primary)]">
              Key Spending Takeaways
            </span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {(insightSentences.length > 0 ? insightSentences : [insights.highestYearInsight]).map(
              (sentence, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-2 text-sm text-[var(--text-primary)]"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--primary)]" />
                  <span>{sentence}</span>
                </li>
              )
            )}
          </ul>
        </div>
      )}

      {/* ── ROW 1: MONTH-OVER-MONTH COMPARISON (Sec 2) + SPENDING PACE (Sec 5) ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Section 2: Month-over-Month Comparison Card */}
        {monthComparison && (
          <div className="flex flex-col justify-between rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                    Month-over-Month Comparison
                  </h2>
                  <p className="text-xs text-[var(--text-muted)]">
                    {monthComparison.thisMonthLabel} vs {monthComparison.lastMonthLabel}
                  </p>
                </div>
                {monthComparison.pctChange !== null && (
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                      monthComparison.diffPaise > 0
                        ? 'bg-[var(--danger-muted)] text-[var(--danger)]'
                        : monthComparison.diffPaise < 0
                        ? 'bg-[var(--success-muted)] text-[var(--success)]'
                        : 'bg-[var(--surface-2)] text-[var(--text-muted)]'
                    }`}
                  >
                    {monthComparison.diffPaise > 0 ? (
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    ) : monthComparison.diffPaise < 0 ? (
                      <ArrowDownRight className="h-3.5 w-3.5" />
                    ) : null}
                    {monthComparison.pctChange > 0 ? '+' : ''}
                    {monthComparison.pctChange}%
                  </span>
                )}
              </div>

              {/* Totals comparison */}
              <div className="grid grid-cols-2 gap-3 rounded-xl bg-[var(--surface-2)] p-3">
                <div>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {monthComparison.thisMonthLabel.split(' ')[0]} ({monthComparison.thisMonthTxCount} txns)
                  </p>
                  <p className="mt-0.5 text-lg font-bold text-[var(--text-primary)]">
                    {formatINR(monthComparison.thisMonthPaise)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {monthComparison.lastMonthLabel.split(' ')[0]} ({monthComparison.lastMonthTxCount} txns)
                  </p>
                  <p className="mt-0.5 text-lg font-semibold text-[var(--text-secondary)]">
                    {formatINR(monthComparison.lastMonthPaise)}
                  </p>
                </div>
              </div>

              {/* Biggest category shifts */}
              <div className="mt-3 flex flex-col gap-2">
                {monthComparison.biggestIncrease && (
                  <div className="flex items-center justify-between rounded-xl border border-[var(--border)] px-3 py-2 text-xs">
                    <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                      <TrendingUp className="h-3.5 w-3.5 text-[var(--danger)]" />
                      <span>Biggest jump:</span>
                      <strong className="text-[var(--text-primary)]">
                        {monthComparison.biggestIncrease.name}
                      </strong>
                    </span>
                    <span className="font-semibold text-[var(--danger)]">
                      +{formatINR(monthComparison.biggestIncrease.diffPaise)}
                      {monthComparison.biggestIncrease.pctChange !== null
                        ? ` (${monthComparison.biggestIncrease.pctChange}%)`
                        : ''}
                    </span>
                  </div>
                )}

                {monthComparison.biggestDecrease && (
                  <div className="flex items-center justify-between rounded-xl border border-[var(--border)] px-3 py-2 text-xs">
                    <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                      <TrendingDown className="h-3.5 w-3.5 text-[var(--success)]" />
                      <span>Biggest drop:</span>
                      <strong className="text-[var(--text-primary)]">
                        {monthComparison.biggestDecrease.name}
                      </strong>
                    </span>
                    <span className="font-semibold text-[var(--success)]">
                      -{formatINR(Math.abs(monthComparison.biggestDecrease.diffPaise))}
                      {monthComparison.biggestDecrease.pctChange !== null
                        ? ` (${Math.abs(monthComparison.biggestDecrease.pctChange)}%)`
                        : ''}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {monthComparison.summarySentence && (
              <p className="mt-3 border-t border-[var(--border)] pt-2.5 text-xs text-[var(--text-muted)]">
                {monthComparison.summarySentence}
              </p>
            )}
          </div>
        )}

        {/* Section 5: Spending Velocity / Pace Card */}
        <div className="flex flex-col justify-between rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--primary-muted)] text-[var(--primary)]">
                  <Gauge className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                    {format(now, 'MMMM')} Spending Pace
                  </h2>
                  <p className="text-xs text-[var(--text-muted)]">
                    Day {daysElapsed} of {daysInMonth} ({Math.round((daysElapsed / daysInMonth) * 100)}% of month elapsed)
                  </p>
                </div>
              </div>
              <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-secondary)]">
                {hasEnoughDaysForPace ? `${formatINRCompact(dailyPacePaise)}/day` : `Day ${daysElapsed}`}
              </span>
            </div>

            <div className="rounded-xl bg-[var(--surface-2)] p-3.5">
              {hasEnoughDaysForPace && projectedMonthEndPaise !== null ? (
                <p className="text-xs text-[var(--text-secondary)]">
                  You've spent{' '}
                  <strong className="text-[var(--text-primary)]">
                    {formatINR(spentThisMonthPaise)}
                  </strong>{' '}
                  so far — at this pace, you're on track for{' '}
                  <strong className="text-[var(--primary)]">
                    ~{formatINR(projectedMonthEndPaise)}
                  </strong>{' '}
                  by month end.
                </p>
              ) : (
                <p className="text-xs text-[var(--text-secondary)]">
                  You've spent{' '}
                  <strong className="text-[var(--text-primary)]">
                    {formatINR(spentThisMonthPaise)}
                  </strong>{' '}
                  so far — not enough data yet this month to project a full-month pace (available from day 3).
                </p>
              )}

              {/* Progress bar showing month elapsed */}
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--surface-3)]">
                <div
                  className="h-full rounded-full bg-[var(--primary)] transition-all"
                  style={{ width: `${Math.min(100, Math.round((daysElapsed / daysInMonth) * 100))}%` }}
                />
              </div>
            </div>
          </div>

          {/* Budget Projection Check */}
          <div className="mt-3">
            {hasActiveBudget && !hasEnoughDaysForPace ? (
              <div className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-xs text-[var(--text-muted)]">
                <span>
                  Monthly budget: <strong className="text-[var(--text-primary)]">{formatINRCompact(effectiveBudgetPaise)}</strong> · Pace comparison unlocks on day 3
                </span>
              </div>
            ) : hasActiveBudget && projectedBudgetDiffPaise !== null ? (
              <div
                className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-xs font-medium ${
                  projectedBudgetDiffPaise <= 0
                    ? 'bg-[var(--success-muted)] text-[var(--success)]'
                    : projectedBudgetDiffPaise <= effectiveBudgetPaise * 0.08
                    ? 'bg-[var(--warning-muted)] text-[var(--warning)]'
                    : 'bg-[var(--danger-muted)] text-[var(--danger)]'
                }`}
              >
                <span>
                  {projectedBudgetDiffPaise <= 0
                    ? `At this pace, you'll finish ${formatINR(Math.abs(projectedBudgetDiffPaise))} under your ${formatINRCompact(effectiveBudgetPaise)} budget.`
                    : `At this pace, you'll be ${formatINR(projectedBudgetDiffPaise)} over your ${formatINRCompact(effectiveBudgetPaise)} budget.`}
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-between rounded-xl border border-dashed border-[var(--border)] px-3.5 py-2.5 text-xs text-[var(--text-muted)]">
                <span>No budget set for {format(now, 'MMMM')}</span>
                <Link
                  to="/app/budgets"
                  className="font-semibold text-[var(--primary)] hover:underline"
                >
                  Set budget →
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── SECTION 1: 12-MONTH MONTH-OVER-MONTH TREND CHART ── */}
      {monthlyTrend.length > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                12-Month Spending Trend
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                Monthly trajectory · * = in-progress month · Hover for MoM % and top category
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {outlierMonths.length > 0 && (
                <span className="rounded-full bg-[var(--warning-muted)] px-2.5 py-1 text-[10px] font-semibold text-[var(--warning)]">
                  ⚡ Spike (&gt;50% above avg): {outlierMonths.map(m => m.label).join(', ')}
                </span>
              )}
            </div>
          </div>

          <ResponsiveContainer width="100%" height={230}>
            <LineChart
              data={monthlyChartData}
              margin={{ top: 22, right: 14, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
              <XAxis
                dataKey="displayLabel"
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
              <Tooltip content={<MonthlyTrendTooltip />} />

              {/* Completed months solid line */}
              <Line
                type="monotone"
                dataKey="solidPaise"
                stroke={primaryColor}
                strokeWidth={2.5}
                connectNulls={false}
                dot={(props: any) => {
                  const { cx, cy, payload } = props
                  if (cx == null || cy == null || payload.solidPaise == null) return <g key={props.key} />
                  if (payload.isOutlier) {
                    return (
                      <g key={props.key}>
                        <circle
                          cx={cx}
                          cy={cy}
                          r={6}
                          fill={warningColor}
                          stroke="var(--surface)"
                          strokeWidth={2}
                        />
                        <text
                          x={cx}
                          y={cy - 10}
                          textAnchor="middle"
                          fill={warningColor}
                          fontSize={9}
                          fontWeight={700}
                        >
                          Spike
                        </text>
                      </g>
                    )
                  }
                  return (
                    <circle
                      key={props.key}
                      cx={cx}
                      cy={cy}
                      r={3.5}
                      fill={primaryColor}
                      stroke="var(--surface)"
                      strokeWidth={1.5}
                    />
                  )
                }}
                activeDot={{ r: 5, fill: primaryColor }}
              />

              {/* In-progress current month dashed segment */}
              {hasCurrentMonthAtEnd && (
                <Line
                  type="monotone"
                  dataKey="dashedPaise"
                  stroke={primaryColor}
                  strokeWidth={2.5}
                  strokeDasharray="5 5"
                  strokeOpacity={0.75}
                  connectNulls={false}
                  dot={(props: any) => {
                    const { cx, cy, payload } = props
                    if (cx == null || cy == null || !payload.isCurrentMonth) return <g key={props.key} />
                    return (
                      <circle
                        key={props.key}
                        cx={cx}
                        cy={cy}
                        r={4.5}
                        fill="var(--surface)"
                        stroke={primaryColor}
                        strokeWidth={2.5}
                      />
                    )
                  }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── ROW 3: CATEGORY 12-MONTH TREND (Sec 3) + DAY-OF-WEEK PATTERN (Sec 4) ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Section 3: Category Trend Over Time */}
        {categoryMonthlyTrends.length > 0 && activeCatTrend && activeCatMeta && (
          <div className="flex flex-col justify-between rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
            <div>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    Category Trend (12 Months)
                  </h3>
                  <p className="text-xs text-[var(--text-muted)]">
                    Track whether a category is creeping up or spiky
                  </p>
                </div>
                <ThemedSelect
                  size="sm"
                  align="end"
                  aria-label="Select category for trend"
                  value={activeCatTrend.categoryId}
                  onChange={val => setSelectedCategoryId(val)}
                  options={categoryMonthlyTrends.map(cat => ({
                    value: cat.categoryId,
                    label: `${getCategoryMeta(cat.name).emoji} ${cat.name}`,
                  }))}
                />
              </div>

              {/* Mini summary pills for selected category */}
              <div className="mb-3 grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2">
                  <p className="text-[10px] text-[var(--text-muted)]">12-mo Total</p>
                  <p className="text-xs font-bold text-[var(--text-primary)]">
                    {formatINRCompact(activeCatTrend.total12mPaise)}
                  </p>
                </div>
                <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2">
                  <p className="text-[10px] text-[var(--text-muted)]">Monthly Avg</p>
                  <p className="text-xs font-bold text-[var(--text-primary)]">
                    {formatINRCompact(activeCatTrend.avgMonthlyPaise)}
                  </p>
                </div>
                <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2">
                  <p className="text-[10px] text-[var(--text-muted)]">Peak Month</p>
                  <p className="truncate text-xs font-bold text-[var(--text-primary)]">
                    {activeCatTrend.peakMonthLabel ?? '—'}
                  </p>
                </div>
              </div>

              <ResponsiveContainer width="100%" height={180}>
                <BarChart
                  data={activeCatTrend.months.map(m => ({
                    ...m,
                    displayLabel: m.isCurrentMonth ? `${m.label.split(' ')[0]}*` : m.label.split(' ')[0],
                  }))}
                  margin={{ top: 8, right: 6, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                  <XAxis
                    dataKey="displayLabel"
                    tick={{ fill: textColor, fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={v => formatINRCompact(v)}
                    tick={{ fill: textColor, fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={46}
                  />
                  <Tooltip
                    cursor={{ fill: 'var(--surface-2)', opacity: 0.6 }}
                    content={
                      <CategoryTrendTooltip
                        categoryName={activeCatTrend.name}
                        categoryEmoji={activeCatMeta.emoji}
                        categoryColor={activeCatMeta.color}
                      />
                    }
                  />
                  <Bar dataKey="totalPaise" radius={[5, 5, 0, 0]}>
                    {activeCatTrend.months.map((m, idx) => (
                      <Cell
                        key={idx}
                        fill={activeCatMeta.color}
                        fillOpacity={m.isCurrentMonth ? 0.5 : 1}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Section 4: Day-of-Week / Spending Pattern */}
        {dayOfWeekStats && (
          <div className="flex flex-col justify-between rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
            <div>
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    Day-of-Week Pattern
                  </h3>
                  <p className="text-xs text-[var(--text-muted)]">
                    Weekday vs weekend spending distribution
                  </p>
                </div>
                <span className="rounded-full bg-[var(--primary-muted)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary)]">
                  Peak: {dayOfWeekStats.peakDayName}
                </span>
              </div>

              <div className="mb-3 grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2">
                  <p className="text-[10px] text-[var(--text-muted)]">Weekday Avg / Day</p>
                  <p className="text-xs font-bold text-[var(--text-primary)]">
                    {formatINRCompact(dayOfWeekStats.weekdayDailyAvgPaise)}
                  </p>
                </div>
                <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2">
                  <p className="text-[10px] text-[var(--text-muted)]">Weekend Avg / Day</p>
                  <p className="text-xs font-bold text-[var(--text-primary)]">
                    {formatINRCompact(dayOfWeekStats.weekendDailyAvgPaise)}
                  </p>
                </div>
              </div>

              <ResponsiveContainer width="100%" height={155}>
                <BarChart
                  data={dayOfWeekStats.days}
                  margin={{ top: 8, right: 6, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                  <XAxis
                    dataKey="shortName"
                    tick={{ fill: textColor, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={v => formatINRCompact(v)}
                    tick={{ fill: textColor, fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={46}
                  />
                  <Tooltip
                    cursor={{ fill: 'var(--surface-2)', opacity: 0.6 }}
                    content={<DayOfWeekTooltip />}
                  />
                  <Bar dataKey="avgPerOccurrencePaise" radius={[5, 5, 0, 0]}>
                    {dayOfWeekStats.days.map((d, idx) => (
                      <Cell
                        key={idx}
                        fill={
                          d.fullName === dayOfWeekStats.peakDayName
                            ? primaryColor
                            : d.isWeekend
                            ? accentColor
                            : primaryColor
                        }
                        fillOpacity={
                          d.fullName === dayOfWeekStats.peakDayName || d.isWeekend ? 1 : 0.45
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {dayOfWeekStats.patternSentence && (
              <p className="mt-2 border-t border-[var(--border)] pt-2.5 text-xs text-[var(--text-muted)]">
                {dayOfWeekStats.patternSentence}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── YEAR-OVER-YEAR BAR CHART (Existing) ── */}
      {yearlyTotals.length > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <div className="mb-1 flex items-start justify-between">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Year-over-Year Spending
              </h3>
              <p className="text-xs text-[var(--text-muted)]">* = current year (partial)</p>
            </div>
            {highestYear && (
              <span className="rounded-full bg-[var(--primary-muted)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary)]">
                Peak: {highestYear.year}
              </span>
            )}
          </div>
          <ResponsiveContainer width="100%" height={190}>
            <BarChart
              data={yearlyTotals.map(y => ({
                ...y,
                label: y.year === currentYear ? `${y.year}*` : String(y.year),
              }))}
              margin={{ top: 12, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
              <XAxis
                dataKey="label"
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
              <Tooltip
                cursor={{ fill: 'var(--surface-2)', opacity: 0.6 }}
                content={<YoYChartTooltip />}
              />
              <Bar dataKey="totalPaise" radius={[6, 6, 0, 0]}>
                {yearlyTotals.map((entry, i) => (
                  <Cell
                    key={`cell-${i}`}
                    fill={primaryColor}
                    fillOpacity={entry.year === currentYear ? 0.5 : 1}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── SECTION 6: EXPANDED STAT CARDS GRID ── */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
          All-Time Records & Spending Habits
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* 1. Highest month ever (existing) */}
          {insights.highestSpendingMonth && (
            <InsightCard
              icon={<TrendingUp className="h-4 w-4" />}
              label="Highest month ever"
              value={formatINRCompact(insights.highestSpendingMonth.totalPaise)}
              sub={format(
                new Date(insights.highestSpendingMonth.monthKey + '-01'),
                'MMMM yyyy'
              )}
            />
          )}

          {/* 2. Highest single DAY ever (new) */}
          {highestSpendingDay && (
            <InsightCard
              icon={<Calendar className="h-4 w-4" />}
              label="Highest single day ever"
              value={formatINR(highestSpendingDay.totalPaise)}
              badge={format(parseISO(highestSpendingDay.dateStr), 'd MMM yyyy')}
              sub={`Driven by ${highestSpendingDay.topDescription} (${highestSpendingDay.topCategoryName})`}
              accentColor="var(--danger)"
              accentBg="var(--danger-muted)"
            />
          )}

          {/* 3. Most expensive category overall (new) */}
          {mostExpensiveCategory && (
            <InsightCard
              icon={<Award className="h-4 w-4" />}
              label="Most expensive category"
              value={mostExpensiveCategory.name}
              badge={`${mostExpensiveCategory.sharePct}% of total`}
              sub={`${formatINRCompact(mostExpensiveCategory.totalPaise)} all-time spend`}
              accentColor={getCategoryColor(mostExpensiveCategory.name)}
            />
          )}

          {/* 4. Most frequent category (existing) */}
          {insights.mostFrequentCategory && (
            <InsightCard
              icon={<Hash className="h-4 w-4" />}
              label="Most frequent category"
              value={insights.mostFrequentCategory.name}
              sub={`${insights.mostFrequentCategory.count} transactions logged`}
              accentColor={getCategoryColor(insights.mostFrequentCategory.name)}
            />
          )}

          {/* 5. Largest single expense (existing) */}
          {insights.largestSingleExpense && (
            <InsightCard
              icon={<Star className="h-4 w-4" />}
              label="Largest single expense"
              value={formatINR(insights.largestSingleExpense.amountPaise)}
              sub={insights.largestSingleExpense.description}
              accentColor="var(--warning)"
              accentBg="var(--warning-muted)"
            />
          )}

          {/* 6. Average transaction size: All-time vs Last 3m (new) */}
          {avgTransactionSize && (
            <InsightCard
              icon={<Scale className="h-4 w-4" />}
              label="Avg transaction size"
              value={formatINR(avgTransactionSize.allTimeAvgPaise)}
              badge={
                avgTransactionSize.pctDiff !== null
                  ? `${avgTransactionSize.pctDiff > 0 ? '+' : ''}${avgTransactionSize.pctDiff}% recent`
                  : undefined
              }
              sub={
                avgTransactionSize.last3MonthsAvgPaise !== null
                  ? `Last 3 mos avg: ${formatINR(avgTransactionSize.last3MonthsAvgPaise)}`
                  : 'Across all logged transactions'
              }
              accentColor="var(--accent)"
              accentBg="var(--accent-muted)"
            />
          )}

          {/* 7. Payment mode habit & shift (new, tied to paymentColors.ts) */}
          {paymentModeInsight && (
            <InsightCard
              icon={<CreditCard className="h-4 w-4" />}
              label="Primary payment mode"
              value={paymentModeInsight.dominantMode}
              badge={`${paymentModeInsight.dominantSharePct}% share`}
              sub={paymentModeInsight.summaryText}
              accentColor={getPaymentColor(paymentModeInsight.dominantMode)}
            />
          )}

          {/* 8. Longest daily logging streak (new) */}
          {longestStreak && longestStreak.longestDays > 0 && (
            <InsightCard
              icon={<Flame className="h-4 w-4" />}
              label="Longest logging streak"
              value={`${longestStreak.longestDays} day${longestStreak.longestDays === 1 ? '' : 's'}`}
              badge={
                longestStreak.currentDays > 0
                  ? `${longestStreak.currentDays}d active`
                  : undefined
              }
              sub={
                longestStreak.longestStartDate && longestStreak.longestEndDate
                  ? `${format(parseISO(longestStreak.longestStartDate), 'd MMM')} – ${format(
                      parseISO(longestStreak.longestEndDate),
                      'd MMM yyyy'
                    )}`
                  : 'Consecutive days with logged expenses'
              }
              accentColor="var(--warning)"
              accentBg="var(--warning-muted)"
            />
          )}

          {/* 9. Most repeated micro spend (existing) */}
          {insights.mostFrequentSmallDesc && (
            <InsightCard
              icon={<Repeat className="h-4 w-4" />}
              label="Most repeated micro spend"
              value={insights.mostFrequentSmallDesc.description}
              sub={`${insights.mostFrequentSmallDesc.count}× under ₹100`}
            />
          )}

          {/* 10. Gifts & Events all-time (existing) */}
          <InsightCard
            icon={<ZapIcon className="h-4 w-4" />}
            label="Gifts & Events all-time"
            value={formatINR(insights.giftEventTotalPaise)}
            accentColor={getCategoryColor('Gifts & Events')}
          />

          {/* 11. Trip spending all-time (existing) */}
          <InsightCard
            icon={<span className="text-base">✈️</span>}
            label="Trip spending all-time"
            value={formatINR(insights.tripTotalPaise)}
            accentColor={getCategoryColor('Travel')}
          />
        </div>
      </div>
    </div>
  )
}
