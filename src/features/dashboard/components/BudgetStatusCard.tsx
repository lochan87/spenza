import { useState, useEffect } from 'react'
import { ChevronRight, Target } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { getCurrentBudget } from '@/services/budgets'
import { formatINR, formatINRCompact } from '@/utils/format'
import { getCategoryMeta } from '@/utils/categoryColors'
import { getBudgetColor } from '@/utils/tripBuckets'
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

  const { thisMonthTxns, thisMonthTotal } = data

  // Compute per-category actuals
  const catActuals = new Map<string, number>()
  for (const tx of thisMonthTxns) {
    catActuals.set(tx.categoryId, (catActuals.get(tx.categoryId) ?? 0) + tx.amountPaise)
  }

  // Overall progress
  const overallPct = budget.totalBudgetPaise
    ? (thisMonthTotal / budget.totalBudgetPaise) * 100
    : null

  // Category budgets with actuals — only show cats that have a budget set
  const catBudgetRows = Object.entries(budget.categoryBudgets)
    .map(([catId, budgetPaise]) => {
      const cat = categories.find(c => c.id === catId)
      const actualPaise = catActuals.get(catId) ?? 0
      const pct = budgetPaise > 0 ? (actualPaise / budgetPaise) * 100 : 0
      return { catId, cat, budgetPaise, actualPaise, pct }
    })
    .filter(r => r.budgetPaise > 0)
    .sort((a, b) => b.pct - a.pct)

  const overLimit = catBudgetRows.filter(r => r.pct >= 90)

  if (!budget.totalBudgetPaise && catBudgetRows.length === 0) return null

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
      {overallPct !== null && budget.totalBudgetPaise && (
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-[var(--text-muted)]">Overall</span>
            <span className="font-medium" style={{ color: getBudgetColor(overallPct) }}>
              {formatINRCompact(thisMonthTotal)} / {formatINRCompact(budget.totalBudgetPaise)} · {overallPct.toFixed(0)}%
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-[var(--surface-2)]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(100, overallPct)}%`,
                backgroundColor: getBudgetColor(overallPct),
              }}
            />
          </div>
        </div>
      )}

      {/* Alert categories (≥ 90%) */}
      {overLimit.length > 0 && (
        <div className="mb-3 rounded-xl bg-[var(--warning-muted)] px-3 py-2">
          <p className="text-xs font-medium text-[var(--warning)]">
            ⚠ {overLimit.map(r => r.cat?.name ?? 'Unknown').join(', ')} over 90%
          </p>
        </div>
      )}

      {/* Per-category rows */}
      <div className="flex flex-col gap-2.5">
        {catBudgetRows.slice(0, 5).map(({ catId, cat, budgetPaise, actualPaise, pct }) => {
          const meta = getCategoryMeta(cat?.name ?? 'Other')
          return (
            <div key={catId}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm">{meta.emoji}</span>
                  <span className="font-medium text-[var(--text-primary)]">{cat?.name ?? 'Other'}</span>
                </div>
                <span className="text-[var(--text-muted)]">
                  {formatINR(actualPaise)} / {formatINR(budgetPaise)}
                </span>
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
