import { useRef, useState } from 'react'
import { format } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import { Bell, Check, X, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { getCategoryMeta } from '@/utils/categoryColors'
import type { RecurringItem, Category } from '@/types'
import { recurringConfirmationErrorMessage, recurringOccurrenceId } from '@/services/recurring'

interface RecurringDuePromptProps {
  items: RecurringItem[]
  categories: Category[]
  onConfirm: (item: RecurringItem, amountPaise: number) => Promise<void>
  onDismiss: (id: string) => void
  onDismissAll: () => void
}

/**
 * Floating prompt shown when recurring expenses are overdue.
 * Shows a list with editable amounts — user must explicitly confirm or skip each one.
 * "Don't auto-create transactions silently" — per spec.
 */
export function RecurringDuePrompt({
  items, categories, onConfirm, onDismiss, onDismissAll,
}: RecurringDuePromptProps) {
  const [expanded, setExpanded] = useState(true)
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const inFlight = useRef(new Set<string>())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [amounts, setAmounts] = useState<Record<string, number>>(
    Object.fromEntries(items.map(i => [recurringOccurrenceId(i), i.amountPaise]))
  )

  if (items.length === 0) return null

  const handleConfirm = async (item: RecurringItem) => {
    if (inFlight.current.has(item.id)) return
    inFlight.current.add(item.id)
    const occurrence = recurringOccurrenceId(item)
    setErrors(prev => ({ ...prev, [item.id]: '' }))
    setLoadingIds(prev => new Set([...prev, item.id]))
    try {
      await onConfirm(item, amounts[occurrence] ?? item.amountPaise)
    } catch (error) {
      setErrors(prev => ({ ...prev, [item.id]: recurringConfirmationErrorMessage(error) }))
    } finally {
      inFlight.current.delete(item.id)
      setLoadingIds(prev => { const n = new Set(prev); n.delete(item.id); return n })
    }
  }

  return (
    <div className="fixed bottom-20 left-4 right-4 z-50 max-w-lg mx-auto md:bottom-6 md:left-auto md:right-6 md:max-w-sm">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-xl)]">
        {/* Header */}
        <div
          className="flex cursor-pointer items-center justify-between bg-[var(--warning-muted)] px-4 py-3"
          onClick={() => setExpanded(e => !e)}
        >
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-[var(--warning)]" />
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              {items.length} Recurring Due
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={e => { e.stopPropagation(); onDismissAll() }}
              disabled={loadingIds.size > 0}
              className="rounded-lg px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
            >
              Skip All
            </button>
            {expanded ? <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" /> : <ChevronUp className="h-4 w-4 text-[var(--text-muted)]" />}
          </div>
        </div>

        {/* Items */}
        {expanded && (
          <div className="max-h-72 overflow-y-auto divide-y divide-[var(--border)]">
            {items.map(item => {
              const cat = categories.find(c => c.id === item.categoryId)
              const catMeta = getCategoryMeta(cat?.name ?? 'Other')
              const dueDate = (item.nextDueDate as Timestamp).toDate()
              const isLoading = loadingIds.has(item.id)
              const occurrence = recurringOccurrenceId(item)

              return (
                <div key={item.id} className="px-4 py-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-base">{catMeta.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                        {item.description}
                      </p>
                      <p className="text-[10px] text-[var(--text-muted)]">
                        Due {format(dueDate, 'd MMM yyyy')}
                      </p>
                    </div>
                    <button
                      onClick={() => onDismiss(item.id)}
                      disabled={isLoading}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Editable amount + confirm */}
                  <div className="flex items-center gap-2">
                    <div className="relative flex flex-1 items-center">
                      <span className="absolute left-3 text-sm font-semibold text-[var(--text-muted)]">₹</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        disabled={isLoading}
                        value={(amounts[occurrence] ?? item.amountPaise) / 100}
                        onChange={e => setAmounts(prev => ({
                          ...prev,
                          [occurrence]: Math.round(Number(e.target.value) * 100),
                        }))}
                        className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] pl-7 pr-3 py-2 text-sm font-semibold text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
                      />
                    </div>
                    <button
                      onClick={() => handleConfirm(item)}
                      disabled={isLoading}
                      className="flex items-center gap-1.5 rounded-lg bg-[var(--success)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {isLoading
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Check className="h-3.5 w-3.5" />}
                      Log it
                    </button>
                  </div>
                  {errors[item.id] && <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{errors[item.id]}</p>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
