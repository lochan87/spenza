import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, TrendingDown, Receipt } from 'lucide-react'
import { format, startOfMonth } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import { useAuth } from '@/hooks/useAuth'
import { getTransactions, getCategories } from '@/services/transactions'
import { getCategoryMeta } from '@/utils/categoryColors'
import { getPaymentMeta } from '@/utils/paymentColors'
import { AddExpenseForm } from '@/features/transactions/AddExpenseForm'
import { Drawer } from '@/components/layout/Drawer'
import type { Category, Transaction } from '@/types'

/**
 * Phase 1 placeholder overview — shows recent 5 transactions and quick stats.
 * Full dashboard with charts is a future phase.
 */
export function OverviewPage() {
  const { user } = useAuth()
  const [recentTxs, setRecentTxs] = useState<Transaction[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [thisMonthTotal, setThisMonthTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    Promise.all([
      getTransactions(user.uid, 5),
      getCategories(user.uid),
    ]).then(([{ transactions }, cats]) => {
      setRecentTxs(transactions)
      setCategories(cats)
      // Calculate this month's spend from recent (rough — full month query in dashboard phase)
      const now = new Date()
      const monthStart = startOfMonth(now).getTime()
      const monthTotal = transactions
        .filter(tx => {
          const d = (tx.date as Timestamp).toDate?.()?.getTime() ?? 0
          return d >= monthStart
        })
        .reduce((s, tx) => s + tx.amountPaise, 0)
      setThisMonthTotal(monthTotal)
      setLoading(false)
    })
  }, [user, formOpen])

  const getCat = (id: string) => categories.find(c => c.id === id)

  return (
    <div className="pb-20 md:pb-6">
      {/* Welcome row */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">
            Hello, {user?.displayName?.split(' ')[0] ?? 'there'} 👋
          </h1>
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">
            {format(new Date(), 'EEEE, d MMMM yyyy')}
          </p>
        </div>
        <button
          id="overview-add-btn"
          onClick={() => setFormOpen(true)}
          className="flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-md)] transition-all hover:bg-[var(--primary-hover)] active:scale-[0.97]"
        >
          <Plus className="h-4 w-4" />
          Add Expense
        </button>
      </div>

      {/* This month card */}
      <div className="mb-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] mb-1">
          <TrendingDown className="h-3.5 w-3.5" />
          This Month
        </div>
        <p className="text-3xl font-bold text-[var(--text-primary)]">
          ₹{(thisMonthTotal / 100).toFixed(0)}
        </p>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {format(new Date(), 'MMMM yyyy')}
        </p>
      </div>

      {/* Recent transactions */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Recent Expenses</h2>
        <Link
          to="/app/transactions"
          className="text-xs font-medium text-[var(--primary)] hover:underline"
        >
          See all
        </Link>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--primary)]" />
        </div>
      ) : recentTxs.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--border)] text-center">
          <Receipt className="h-10 w-10 text-[var(--text-subtle)]" />
          <p className="text-sm text-[var(--text-muted)]">No expenses yet — add your first one!</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)] overflow-hidden">
          {recentTxs.map(tx => {
            const cat = getCat(tx.categoryId)
            const catMeta = getCategoryMeta(cat?.name ?? 'Other')
            const payMeta = getPaymentMeta(tx.paymentMode)
            return (
              <div key={tx.id} className="flex items-center gap-3 px-3 py-3 hover:bg-[var(--surface-2)] transition-colors">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base"
                  style={{ backgroundColor: catMeta.color + '20' }}
                >
                  {catMeta.emoji}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                    {tx.description}
                  </p>
                  <span
                    className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold mt-0.5"
                    style={{ backgroundColor: payMeta.bgColor, color: payMeta.color }}
                  >
                    {tx.paymentMode}
                  </span>
                </div>
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                  ₹{(tx.amountPaise / 100).toFixed(0)}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Mobile FAB */}
      <button
        id="overview-fab-mobile"
        onClick={() => setFormOpen(true)}
        className="fixed bottom-20 right-5 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--primary)] shadow-[var(--shadow-lg)] transition-all hover:bg-[var(--primary-hover)] active:scale-95 md:hidden"
        aria-label="Add expense"
      >
        <Plus className="h-7 w-7 text-white" />
      </button>

      <Drawer open={formOpen} onClose={() => setFormOpen(false)}>
        <AddExpenseForm
          categories={categories}
          onSuccess={() => setFormOpen(false)}
          onClose={() => setFormOpen(false)}
        />
      </Drawer>
    </div>
  )
}
