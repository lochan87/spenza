import { useState, useEffect } from 'react'
import { ChevronRight, Target } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { getCurrentBudget } from '@/services/budgets'
import { formatINR, formatINRCompact } from '@/utils/format'
import { getCategoryMeta } from '@/utils/categoryColors'
import { getBudgetColor } from '@/utils/tripBuckets'
import { deriveBudgetStatus } from '@/utils/budgetMath'
import type { DashboardData } from '@/features/dashboard/dashboardData'
import type { Budget, Category } from '@/types'

interface BudgetStatusCardProps {
  data: DashboardData
  categories: Category[]
}

export function BudgetStatusCard({ data, categories }: BudgetStatusCardProps) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [budget, setBudget] = useState<Budget | null>(null)

  useEffect(() => {
    if (!user) return
    getCurrentBudget(user.uid)
      .then(setBudget)
      .catch(console.error)
  }, [user])

  if (!budget) return null

  const { thisMonthTxns } = data
  const { overall, categoryRows, alertCategories } = deriveBudgetStatus(
    budget,
    thisMonthTxns,
    categories
  )

  if (!overall.totalBudgetPaise && categoryRows.length === 0) return null

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary-muted)]">
            <Target className="h-3.5 w-3.5 text-[var(--primary)]" />
          </div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Budget Status</h3>
        </div>
        <button
          onClick={() => navigate('/app/budgets')}
          className="flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"
        >
          Edit <ChevronRight className="h-3 w-3" />
        </button>
      </div>

      {/* Overall progress */}
      {overall.pct !== null && overall.totalBudgetPaise !== null && (
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-[var(--text-muted)]">Overall</span>
            <div className="flex items-center gap-1.5 font-medium" style={{ color: getBudgetColor(overall.pct) }}>
              <span>
                {formatINRCompact(overall.actualPaise)} / {formatINRCompact(overall.totalBudgetPaise)} · {overall.pct.toFixed(0)}%
              </span>
              {overall.remainingPaise !== null && (
                <span className="text-[10px] text-[var(--text-subtle)]">
                  ({overall.remainingPaise >= 0 ? `${formatINRCompact(overall.remainingPaise)} left` : `${formatINRCompact(Math.abs(overall.remainingPaise))} over`})
                </span>
              )}
            </div>
          </div>
          <div className="h-2 w-full rounded-full bg-[var(--surface-2)]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(100, overall.pct)}%`,
                backgroundColor: getBudgetColor(overall.pct),
              }}
            />
          </div>
        </div>
      )}

      {/* Alert categories (≥ 90%) */}
      {alertCategories.length > 0 && (
        <div className="mb-3 rounded-xl bg-[var(--warning-muted)] px-3 py-2">
          <p className="text-xs font-medium text-[var(--warning)]">
            ⚠ {alertCategories.map(r => r.categoryName).join(', ')} over 90%
          </p>
        </div>
      )}

      {/* Per-category rows */}
      <div className="flex flex-col gap-2.5">
        {categoryRows.slice(0, 5).map(({ categoryId, categoryName, budgetPaise, actualPaise, remainingPaise, pct }) => {
          const meta = getCategoryMeta(categoryName)
          return (
            <div key={categoryId}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm">{meta.emoji}</span>
                  <span className="font-medium text-[var(--text-primary)]">{categoryName}</span>
                </div>
                <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                  <span>{formatINR(actualPaise)} / {formatINR(budgetPaise)}</span>
                  <span className="text-[10px] text-[var(--text-subtle)]">
                    · {remainingPaise >= 0 ? `${formatINRCompact(remainingPaise)} left` : `${formatINRCompact(Math.abs(remainingPaise))} over`}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-2)]">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, pct)}%`,
                      backgroundColor: getBudgetColor(pct),
                    }}
                  />
                </div>
                <span className="shrink-0 text-[10px] font-medium" style={{ color: getBudgetColor(pct) }}>
                  {pct.toFixed(0)}%
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
