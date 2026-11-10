import { Pencil } from 'lucide-react'
import { format } from 'date-fns'
import { getCategoryMeta } from '@/utils/categoryColors'
import { getPaymentMeta } from '@/utils/paymentColors'
import { formatINR, parseTransactionDate } from '@/utils/format'
import { getNetSpendPaise, getRecoverablePaise } from '@/utils/splitMath'
import type { Transaction, Category } from '@/types'

interface BiggestExpensesProps {
  transactions: Transaction[]
  categories: Category[]
  onEdit: (tx: Transaction) => void
}

export function BiggestExpenses({ transactions, categories, onEdit }: BiggestExpensesProps) {
  if (transactions.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Biggest Expenses</h3>
        <p className="text-sm text-[var(--text-muted)]">No data yet.</p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      <h3 className="mb-4 text-sm font-semibold text-[var(--text-primary)]">
        Biggest Expenses
      </h3>
      <div className="flex flex-col divide-y divide-[var(--border)]">
        {transactions.map(tx => {
          const cat = categories.find(c => c.id === tx.categoryId)
          const catMeta = getCategoryMeta(cat?.name ?? 'Other')
          const payMeta = getPaymentMeta(tx.paymentMode)
          const txDate = parseTransactionDate(tx.date)
          const dateStr = txDate ? format(txDate, 'd MMM') : ''
          const netPaise = getNetSpendPaise(tx)
          const recPaise = getRecoverablePaise(tx)

          return (
            <div
              key={tx.id}
              className="group flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
            >
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
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className="inline-block rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                    style={{ backgroundColor: payMeta.bgColor, color: payMeta.color }}
                  >
                    {tx.paymentMode}
                  </span>
                  {dateStr && (
                    <span className="text-[10px] text-[var(--text-subtle)]">{dateStr}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex flex-col items-end">
                  <span className="text-sm font-bold text-[var(--text-primary)]">
                    {formatINR(netPaise)}
                  </span>
                  {recPaise > 0 && (
                    <span className="text-[10px] text-[var(--text-subtle)]">
                      Gross {formatINR(tx.amountPaise)}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => onEdit(tx)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--surface-2)] hover:text-[var(--primary)]"
                  aria-label="Edit"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
