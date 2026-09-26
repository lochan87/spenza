import { useState, useEffect, useCallback } from 'react'
import { format } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import { Plus, Save, Copy, Target, Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { getCurrentBudget, getLastMonthBudget, saveBudget } from '@/services/budgets'
import { getCategories } from '@/services/transactions'
import { formatINR, formatINRCompact } from '@/utils/format'
import { getCategoryMeta } from '@/utils/categoryColors'
import { getBudgetColor, getBudgetBg } from '@/utils/tripBuckets'
import { SkeletonCard } from '@/features/dashboard/components/SkeletonCard'
import type { Budget, Category } from '@/types'

// ── Budget color label helper ─────────────────────────────────────────────────
function budgetStatus(pct: number): string {
  if (pct >= 100) return 'Over budget'
  if (pct >= 90) return 'Almost at limit'
  if (pct >= 70) return 'Watch out'
  return 'On track'
}

export function BudgetPage() {
  const { user } = useAuth()
  const currentMonth = format(new Date(), 'yyyy-MM')
  const monthLabel = format(new Date(), 'MMMM yyyy')

  const [categories, setCategories] = useState<Category[]>([])
  const [budget, setBudget] = useState<Budget | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Editable state
  const [overallRupees, setOverallRupees] = useState<string>('')
  const [catBudgets, setCatBudgets] = useState<Record<string, string>>({}) // categoryId → rupee string

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    try {
      const [cats, bgt] = await Promise.all([
        getCategories(user.uid),
        getCurrentBudget(user.uid),
      ])
      setCategories(cats.filter(c => !c.isArchived))
      setBudget(bgt)
      if (bgt) {
        setOverallRupees(bgt.totalBudgetPaise != null ? String(bgt.totalBudgetPaise / 100) : '')
        const catMap: Record<string, string> = {}
        for (const [id, p] of Object.entries(bgt.categoryBudgets)) {
          catMap[id] = String(p / 100)
        }
        setCatBudgets(catMap)
      }
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => { load() }, [load])

  const handleCopyLastMonth = async () => {
    if (!user) return
    const last = await getLastMonthBudget(user.uid)
    if (!last) { alert('No budget found for last month.'); return }
    setOverallRupees(last.totalBudgetPaise != null ? String(last.totalBudgetPaise / 100) : '')
    const catMap: Record<string, string> = {}
    for (const [id, p] of Object.entries(last.categoryBudgets)) {
      catMap[id] = String(p / 100)
    }
    setCatBudgets(catMap)
  }

  const handleSave = async () => {
    if (!user) return
    setSaving(true)
    try {
      const totalBudgetPaise = overallRupees ? Math.round(Number(overallRupees) * 100) : null
      const categoryBudgets: Record<string, number> = {}
      for (const [id, v] of Object.entries(catBudgets)) {
        if (v) categoryBudgets[id] = Math.round(Number(v) * 100)
      }
      await saveBudget(user.uid, currentMonth, { totalBudgetPaise, categoryBudgets })
      await load()
    } finally {
      setSaving(false)
    }
  }

  // Computed totals for progress display (from existing budget if saved)
  const savedCatBudgets = budget?.categoryBudgets ?? {}

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <SkeletonCard height="h-24" />
        <SkeletonCard height="h-64" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5 pb-20 md:pb-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Budgets</h1>
          <p className="text-sm text-[var(--text-muted)]">{monthLabel}</p>
        </div>
        <button
          onClick={handleCopyLastMonth}
          className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
        >
          <Copy className="h-3.5 w-3.5" /> Copy last month
        </button>
      </div>

      {/* Overall budget */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
        <div className="mb-3 flex items-center gap-2">
          <Target className="h-4 w-4 text-[var(--primary)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Overall Monthly Budget</h3>
        </div>
        <div className="relative flex items-center gap-3">
          <span className="absolute left-4 font-semibold text-[var(--text-muted)]">₹</span>
          <input
            type="number"
            min="0"
            step="100"
            value={overallRupees}
            onChange={e => setOverallRupees(e.target.value)}
            placeholder="Leave blank for no limit"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] pl-9 pr-4 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
          />
        </div>
      </div>

      {/* Per-category budgets */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
        <h3 className="mb-4 text-sm font-semibold text-[var(--text-primary)]">Category Budgets</h3>
        <div className="flex flex-col gap-3">
          {categories.map(cat => {
            const meta = getCategoryMeta(cat.name)
            const savedPaise = savedCatBudgets[cat.id]
            return (
              <div key={cat.id} className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base"
                  style={{ backgroundColor: meta.color + '18' }}>
                  {meta.emoji}
                </div>
                <span className="w-28 shrink-0 text-sm text-[var(--text-primary)] truncate">{cat.name}</span>
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-[var(--text-muted)]">₹</span>
                  <input
                    type="number"
                    min="0"
                    step="50"
                    value={catBudgets[cat.id] ?? ''}
                    onChange={e => setCatBudgets(prev => ({ ...prev, [cat.id]: e.target.value }))}
                    placeholder="No limit"
                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
                  />
                </div>
                {savedPaise && (
                  <span className="text-xs text-[var(--text-subtle)] shrink-0">
                    {formatINRCompact(savedPaise)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white shadow-[var(--shadow-md)] disabled:opacity-60"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save Budget
      </button>

      {/* Budget Progress — shown if budget is saved */}
      {budget && Object.keys(savedCatBudgets).length > 0 && (
        <BudgetProgress categories={categories} budget={budget} />
      )}
    </div>
  )
}

// ── Budget progress view ──────────────────────────────────────────────────────

function BudgetProgress({ categories, budget }: { categories: Category[]; budget: Budget }) {
  // NOTE: This component shows the stored budget limits.
  // Actual spend is passed via the DashboardPage → BudgetStatusCard pattern.
  // Here on BudgetPage we show limits with a note to visit Dashboard for live progress.
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Saved Limits</p>
      <div className="flex flex-col gap-3">
        {Object.entries(budget.categoryBudgets).map(([catId, budgetPaise]) => {
          const cat = categories.find(c => c.id === catId)
          const meta = getCategoryMeta(cat?.name ?? 'Other')
          return (
            <div key={catId}>
              <div className="mb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span>{meta.emoji}</span>
                  <span className="text-sm text-[var(--text-primary)]">{cat?.name ?? 'Other'}</span>
                </div>
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                  {formatINR(budgetPaise)}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-xs text-[var(--text-subtle)]">
        💡 Live budget progress with spending vs. limit is shown on the Dashboard.
      </p>
    </div>
  )
}
