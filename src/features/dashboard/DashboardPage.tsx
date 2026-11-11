import { Notification } from '@/components/ui/Notification'
import { useNotice } from '@/hooks/useNotice'
import { useState, useCallback } from 'react'
import { AlertCircle, RefreshCw, Receipt, Plus } from 'lucide-react'
import { useDashboardData } from './useDashboardData'
import { DashboardSkeleton } from './components/SkeletonCard'
import { SummaryHeader } from './components/SummaryHeader'
import { QuickStatsRow } from './components/QuickStatsRow'
import { PendingRecoverablesCard } from './components/PendingRecoverablesCard'
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
 * Data: single Firestore query covering full owner history, all 8 sections derived client-side.
 * Loading: per-section skeletons (not one full-page spinner).
 */
export function DashboardPage() {
  const { data, categories, loading, error, refetch, isStale, isFromCache, isOnline } = useDashboardData()
  const { notice, showNotice, dismiss } = useNotice()
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

  const handleFormSuccess = useCallback((status?: 'confirmed' | 'pending') => {
    showNotice(status === 'pending' ? 'Expense pending sync — not yet confirmed saved. Do not enter it again.' : 'Expense saved ✓', status === 'pending' ? 'warning' : 'success')
    setFormOpen(false)
    setEditTx(null)
    refetch()
  }, [refetch, showNotice])

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

  // New account: no transactions at all in the last 6 months
  const isEmpty = data.txnCount === 0 && data.thisMonthTotal === 0

  return (
    <div className="flex flex-col gap-5">
      <Notification notice={notice} onDismiss={dismiss} />
      <button id="overview-add-btn" type="button" onClick={() => { setEditTx(null); setFormOpen(true) }}
        className="flex items-center justify-center gap-2 self-start rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--primary-hover)]">
        <Plus className="h-4 w-4" /> Add Transaction
      </button>
      {/* Section 1 — Summary Header */}
      <SummaryHeader
        data={data}
        isStale={isStale}
        isFromCache={isFromCache}
        isOffline={!isOnline}
      />

      {/* Empty state banner — shown when no transactions exist yet */}
      {isEmpty && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <Receipt className="h-10 w-10 text-[var(--text-subtle)]" />
          <div>
            <p className="font-semibold text-[var(--text-primary)]">No expenses yet this month</p>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Use Add Transaction above to log an expense, or Import to bring in historical data.
            </p>
          </div>
        </div>
      )}

      {/* Section 2 — Quick Stats Row */}
      <QuickStatsRow data={data} />

      {/* Recoverables & Pending Dues */}
      <PendingRecoverablesCard data={data} />

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
          totalGrossOutflow={data.thisMonthGrossOutflow}
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
