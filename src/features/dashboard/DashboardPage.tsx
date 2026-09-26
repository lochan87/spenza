import { useState, useCallback } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useDashboardData } from './useDashboardData'
import { DashboardSkeleton } from './components/SkeletonCard'
import { SummaryHeader } from './components/SummaryHeader'
import { QuickStatsRow } from './components/QuickStatsRow'
import { SpendingBreakdown } from './components/SpendingBreakdown'
import { TrendChart } from './components/TrendChart'
import { TopCategories } from './components/TopCategories'
import { BiggestExpenses } from './components/BiggestExpenses'
import { MicroSpendCard } from './components/MicroSpendCard'
import { PaymentBreakdown } from './components/PaymentBreakdown'
import { UpcomingRecurringCard } from './components/UpcomingRecurringCard'
import { BudgetStatusCard } from './components/BudgetStatusCard'
import { AddExpenseForm } from '@/features/transactions/AddExpenseForm'
import { Drawer } from '@/components/layout/Drawer'
import type { Transaction } from '@/types'

/**
 * Dashboard — the first screen users see.
 * Answers "where is my money actually going?" at a glance.
 *
 * Data: single Firestore query covering 6 months, all 8 sections derived client-side.
 * Loading: per-section skeletons (not one full-page spinner).
 */
export function DashboardPage() {
  const { data, categories, loading, error, refetch } = useDashboardData()
  const [editTx, setEditTx] = useState<Transaction | null>(null)
  const [formOpen, setFormOpen] = useState(false)

  const handleEditTx = useCallback((tx: Transaction) => {
    setEditTx(tx)
    setFormOpen(true)
  }, [])

  const handleFormClose = useCallback(() => {
    setFormOpen(false)
    setEditTx(null)
  }, [])

  const handleFormSuccess = useCallback(() => {
    setFormOpen(false)
    setEditTx(null)
    refetch()
  }, [refetch])

  if (loading) return <DashboardSkeleton />

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-4 rounded-2xl border border-[var(--danger-muted)] bg-[var(--surface)]">
        <AlertCircle className="h-10 w-10 text-[var(--danger)]" />
        <p className="text-sm text-[var(--text-muted)]">{error}</p>
        <button
          onClick={refetch}
          className="flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    )
  }

  if (!data) return <DashboardSkeleton />

  return (
    <div className="flex flex-col gap-5 pb-20 md:pb-6">
      {/* Section 1 — Summary Header */}
      <SummaryHeader data={data} />

      {/* Section 2 — Quick Stats Row */}
      <QuickStatsRow data={data} />

      {/* Section 3 — Normal Spend Breakdown */}
      <SpendingBreakdown data={data} />

      {/* Section 4 — 6-Month Trend Chart */}
      <TrendChart monthlyTotals={data.monthlyTotals} />

      {/* Sections 5 + 6 — Top Categories + Biggest Expenses */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TopCategories
          topCategories={data.topCategories}
          totalThisMonth={data.thisMonthTotal}
        />
        <BiggestExpenses
          transactions={data.biggestExpenses}
          categories={categories}
          onEdit={handleEditTx}
        />
      </div>

      {/* Sections 7 + 8 — Micro Spending + Payment Breakdown */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MicroSpendCard data={data} />
        <PaymentBreakdown
          paymentModeTotals={data.paymentModeTotals}
          accountTotals={data.accountTotals}
          totalThisMonth={data.thisMonthTotal}
        />
      </div>

      {/* Section 9 — Upcoming Recurring */}
      <UpcomingRecurringCard categories={categories} />

      {/* Section 10 — Budget Status */}
      <BudgetStatusCard data={data} categories={categories} />

      {/* Edit expense drawer (opened from BiggestExpenses) */}
      <Drawer open={formOpen} onClose={handleFormClose}>
        <AddExpenseForm
          categories={categories}
          onSuccess={handleFormSuccess}
          onClose={handleFormClose}
          editTransaction={editTx}
        />
      </Drawer>
    </div>
  )
}
