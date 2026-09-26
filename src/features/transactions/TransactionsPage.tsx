import { useState, useEffect, useCallback, useRef } from 'react'
import { format, isToday, isYesterday } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import { Plus, Trash2, Pencil, Loader2, Receipt } from 'lucide-react'
import type { QueryDocumentSnapshot } from 'firebase/firestore'

import { useAuth } from '@/hooks/useAuth'
import { getTransactions, deleteTransaction, getCategories } from '@/services/transactions'
import { getCategoryMeta } from '@/utils/categoryColors'
import { getPaymentMeta } from '@/utils/paymentColors'
import { AddExpenseForm } from './AddExpenseForm'
import { Drawer } from '@/components/layout/Drawer'
import type { Transaction, Category } from '@/types'

// ─── Badge helper ─────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  if (type === 'everyday') return null
  const map: Record<string, string> = {
    recurring: 'badge-recurring',
    'one-time': 'badge-one-time',
    trip: 'badge-trip',
    'gift-event': 'badge-gift-event',
    reimbursable: 'badge-reimbursable',
  }
  const labels: Record<string, string> = {
    recurring: 'Recurring',
    'one-time': 'One-time',
    trip: 'Trip',
    'gift-event': 'Gift/Event',
    reimbursable: 'Reimburse',
  }
  return (
    <span className={`${map[type] ?? ''} inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none`}>
      {labels[type] ?? type}
    </span>
  )
}

// ─── Date group header ────────────────────────────────────────────────────────

function dateLabel(ts: Timestamp): string {
  const d = ts.toDate?.() ?? new Date()
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'dd MMM yyyy, EEEE')
}

function groupByDate(transactions: Transaction[]): { label: string; items: Transaction[] }[] {
  const groups: Map<string, Transaction[]> = new Map()
  for (const tx of transactions) {
    const label = dateLabel(tx.date as Timestamp)
    const group = groups.get(label) ?? []
    group.push(tx)
    groups.set(label, group)
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }))
}

// ─── Transaction row ──────────────────────────────────────────────────────────

function TransactionRow({
  tx,
  category,
  onEdit,
  onDelete,
}: {
  tx: Transaction
  category: Category | undefined
  onEdit: (tx: Transaction) => void
  onDelete: (tx: Transaction) => void
}) {
  const [showActions, setShowActions] = useState(false)
  const payMeta = getPaymentMeta(tx.paymentMode)
  const catMeta = getCategoryMeta(category?.name ?? 'Other')

  return (
    <div
      className="group relative flex items-center gap-3 rounded-xl border border-transparent px-3 py-3 transition-all hover:border-[var(--border)] hover:bg-[var(--surface-2)]"
      onClick={() => setShowActions(v => !v)}
    >
      {/* Category icon */}
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg"
        style={{ backgroundColor: catMeta.color + '20' }}
      >
        {catMeta.emoji}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]">
            {tx.description}
          </p>
          <TypeBadge type={tx.type} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {/* Payment badge */}
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
            style={{ backgroundColor: payMeta.bgColor, color: payMeta.color }}
          >
            {tx.paymentMode}
          </span>
          {category && (
            <span className="text-[10px] text-[var(--text-subtle)]">{category.name}</span>
          )}
        </div>
      </div>

      {/* Amount */}
      <div className="flex flex-col items-end gap-1">
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          ₹{(tx.amountPaise / 100).toFixed(2)}
        </span>
      </div>

      {/* Hover actions */}
      <div className={`flex items-center gap-1 transition-all ${showActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
        <button
          onClick={e => { e.stopPropagation(); onEdit(tx) }}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--primary)] transition-colors"
          aria-label="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDelete(tx) }}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] transition-colors"
          aria-label="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

// ─── Delete confirm dialog ────────────────────────────────────────────────────

function DeleteConfirm({
  tx,
  onConfirm,
  onCancel,
}: {
  tx: Transaction
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-xl)]">
        <h3 className="mb-2 text-base font-semibold text-[var(--text-primary)]">Delete expense?</h3>
        <p className="mb-5 text-sm text-[var(--text-muted)]">
          "{tx.description}" — ₹{(tx.amountPaise / 100).toFixed(2)} will be permanently deleted.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-xl border border-[var(--border)] py-2.5 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--surface-2)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-[var(--danger)] py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function TransactionsPage() {
  const { user } = useAuth()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const lastDocRef = useRef<QueryDocumentSnapshot | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editTx, setEditTx] = useState<Transaction | null>(null)
  const [deleteTx, setDeleteTx] = useState<Transaction | null>(null)

  const loadTransactions = useCallback(async (reset = false) => {
    if (!user) return
    if (reset) {
      setLoading(true)
      lastDocRef.current = null
    } else {
      setLoadingMore(true)
    }
    const { transactions: txs, lastDoc } = await getTransactions(
      user.uid, 30,
      reset ? undefined : lastDocRef.current ?? undefined
    )
    lastDocRef.current = lastDoc
    setHasMore(txs.length === 30)
    setTransactions(prev => reset ? txs : [...prev, ...txs])
    setLoading(false)
    setLoadingMore(false)
  }, [user])

  useEffect(() => {
    if (user) {
      getCategories(user.uid).then(setCategories)
      loadTransactions(true)
    }
  }, [user, loadTransactions])

  const handleSuccess = useCallback(() => {
    loadTransactions(true)
  }, [loadTransactions])

  const handleDelete = useCallback(async () => {
    if (!user || !deleteTx) return
    await deleteTransaction(user.uid, deleteTx.id)
    setDeleteTx(null)
    loadTransactions(true)
  }, [user, deleteTx, loadTransactions])

  const getCat = (categoryId: string) => categories.find(c => c.id === categoryId)

  const groups = groupByDate(transactions)

  // Totals
  const total = transactions.reduce((sum, tx) => sum + tx.amountPaise, 0)

  return (
    <div className="pb-20 md:pb-6">
      {/* Header row */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Transactions</h1>
          {!loading && (
            <p className="mt-0.5 text-sm text-[var(--text-muted)]">
              {transactions.length} entries · ₹{(total / 100).toFixed(0)} total
            </p>
          )}
        </div>
        <button
          id="add-expense-fab-desktop"
          onClick={() => { setEditTx(null); setFormOpen(true) }}
          className="flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-md)] transition-all hover:bg-[var(--primary-hover)] active:scale-[0.97]"
        >
          <Plus className="h-4 w-4" />
          Add Expense
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--primary)]" />
        </div>
      ) : transactions.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-[var(--border)] text-center">
          <Receipt className="h-12 w-12 text-[var(--text-subtle)]" />
          <div>
            <p className="font-medium text-[var(--text-primary)]">No expenses yet</p>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Tap "Add Expense" to log your first one</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map(({ label, items }) => (
            <div key={label}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {label}
                </h3>
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  ₹{(items.reduce((s, t) => s + t.amountPaise, 0) / 100).toFixed(0)}
                </span>
              </div>
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden divide-y divide-[var(--border)]">
                {items.map(tx => (
                  <TransactionRow
                    key={tx.id}
                    tx={tx}
                    category={getCat(tx.categoryId)}
                    onEdit={tx => { setEditTx(tx); setFormOpen(true) }}
                    onDelete={setDeleteTx}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Load more */}
          {hasMore && (
            <button
              onClick={() => loadTransactions(false)}
              disabled={loadingMore}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--border)] py-3 text-sm text-[var(--text-muted)] transition-all hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-60"
            >
              {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Load more'}
            </button>
          )}
        </div>
      )}

      {/* FAB for mobile */}
      <button
        id="add-expense-fab-mobile"
        onClick={() => { setEditTx(null); setFormOpen(true) }}
        className="fixed bottom-20 right-5 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--primary)] shadow-[var(--shadow-lg)] transition-all hover:bg-[var(--primary-hover)] active:scale-95 md:hidden"
        aria-label="Add expense"
      >
        <Plus className="h-7 w-7 text-white" />
      </button>

      {/* Add/Edit drawer */}
      <Drawer open={formOpen} onClose={() => { setFormOpen(false); setEditTx(null) }}>
        <AddExpenseForm
          categories={categories}
          onSuccess={handleSuccess}
          onClose={() => { setFormOpen(false); setEditTx(null) }}
          editTransaction={editTx}
        />
      </Drawer>

      {/* Delete confirm */}
      {deleteTx && (
        <DeleteConfirm
          tx={deleteTx}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTx(null)}
        />
      )}
    </div>
  )
}
