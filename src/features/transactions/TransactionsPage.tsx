import { Notification } from '@/components/ui/Notification'
import { useNotice } from '@/hooks/useNotice'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { format, isToday, isYesterday } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import {
  Plus, Trash2, Pencil, Loader2, Receipt, Search, X,
  ChevronDown, ChevronUp, ExternalLink, Layers, RotateCcw,
  Users, Check, AlertTriangle, WifiOff, RefreshCw,
} from 'lucide-react'

import { useAuth } from '@/hooks/useAuth'
import { useFinancialSync } from '@/hooks/useFinancialSync'
import { assertExpenseCanBeDeleted, ExpenseDeletionError } from '@/utils/expenseDeletion'
import {
  getAllTransactions,
  deleteTransaction,
  getCategories,
  getPaymentAccounts,
} from '@/services/transactions'
import { getTrips } from '@/services/trips'
import { getCategoryMeta } from '@/utils/categoryColors'
import { getPaymentMeta, getAccountTypeMeta } from '@/utils/paymentColors'
import { formatINR, formatTxAmount, parseTransactionDate } from '@/utils/format'
import {
  getRecoverablePaise,
  getNetSpendPaise,
  getRepaidPaise,
  getPendingRecoverablePaise,
  getReimbursementStatus,
  getNormalizedSplits,
  isSplitOrRecoverable,
  aggregatePeopleDues,
  UNASSIGNED_PERSON_ID,
  type PersonDuesSummary,
} from '@/utils/splitMath'
import { ThemedSelect } from '@/components/ui/ThemedSelect'
import { seedCategories, seedPaymentAccounts } from '@/services/seed'
import { AddExpenseForm } from './AddExpenseForm'
import { Drawer } from '@/components/layout/Drawer'
import {
  recordSplitRepayment,
  settleSplitShare,
  settleAllTransactionSplits,
  settlePersonAllDues,
} from '@/services/people'
import type {
  Transaction,
  Category,
  PaymentAccount,
  Trip,
  PaymentMode,
  ReimbursementStatus,
  SplitShare,
} from '@/types'

const VISIBLE_GROUPS_STEP = 15

// ─── Badge helpers ────────────────────────────────────────────────────────────

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
    <span className={`${map[type] ?? ''} inline-block shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none`}>
      {labels[type] ?? type}
    </span>
  )
}

function ReimbursementBadge({ status }: { status: ReimbursementStatus }) {
  if (status === 'none') return null
  if (status === 'settled') {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--success-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--success)] leading-none">
        Settled
      </span>
    )
  }
  if (status === 'partial') {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--primary-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--primary)] leading-none">
        Partial
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--warning-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--warning)] leading-none">
      Pending
    </span>
  )
}

// ─── Date group helpers ───────────────────────────────────────────────────────

function dateLabel(ts: unknown): string {
  const d = parseTransactionDate(ts)
  if (!d) return 'Undated'
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'dd MMM yyyy, EEEE')
}

type FeedEntry =
  | { kind: 'single'; tx: Transaction }
  | {
      kind: 'trip-bundle'
      tripId: string
      trip: Trip | undefined
      items: Transaction[]
      totalPaise: number
      latestDate: unknown
    }

interface DateGroup {
  label: string
  entries: FeedEntry[]
  totalPaise: number
}

/**
 * Group transactions by calendar date.
 * When `collapseTrips` is enabled, all transactions belonging to the same `tripId`
 * are bundled into a single collapsible Trip card anchored at the trip's most recent
 * transaction date in the filtered view, so a 26-row trip doesn't flood the main feed
 * or look like 26 unrelated everyday expenses.
 */
function buildDateGroups(
  transactions: Transaction[],
  tripMap: Map<string, Trip>,
  collapseTrips: boolean
): DateGroup[] {
  const groups = new Map<string, { entries: FeedEntry[]; totalPaise: number }>()

  const addEntry = (label: string, entry: FeedEntry, amountPaise: number) => {
    const existing = groups.get(label) ?? { entries: [], totalPaise: 0 }
    existing.entries.push(entry)
    existing.totalPaise += amountPaise
    groups.set(label, existing)
  }

  if (!collapseTrips) {
    for (const tx of transactions) {
      const label = dateLabel(tx.date as Timestamp)
      addEntry(label, { kind: 'single', tx }, tx.amountPaise)
    }
  } else {
    // Group trip transactions by tripId (when a trip has >= 2 rows in the filtered list)
    const tripBuckets = new Map<string, Transaction[]>()
    for (const tx of transactions) {
      if (tx.tripId) {
        const list = tripBuckets.get(tx.tripId) ?? []
        list.push(tx)
        tripBuckets.set(tx.tripId, list)
      }
    }

    const emittedTrips = new Set<string>()
    for (const tx of transactions) {
      if (tx.tripId && (tripBuckets.get(tx.tripId)?.length ?? 0) >= 2) {
        if (emittedTrips.has(tx.tripId)) continue
        emittedTrips.add(tx.tripId)
        const items = tripBuckets.get(tx.tripId)!
        const totalPaise = items.reduce((s, t) => s + t.amountPaise, 0)
        const latestDate = items[0].date as Timestamp
        const label = dateLabel(latestDate)
        addEntry(
          label,
          {
            kind: 'trip-bundle',
            tripId: tx.tripId,
            trip: tripMap.get(tx.tripId),
            items,
            totalPaise,
            latestDate,
          },
          totalPaise
        )
      } else {
        const label = dateLabel(tx.date as Timestamp)
        addEntry(label, { kind: 'single', tx }, tx.amountPaise)
      }
    }
  }

  return [...groups.entries()].map(([label, data]) => ({
    label,
    entries: data.entries,
    totalPaise: data.totalPaise,
  }))
}

// ─── Transaction row ──────────────────────────────────────────────────────────

function TransactionRow({
  tx,
  category,
  account,
  trip,
  showDateBadge,
  onEdit,
  onDelete,
  onRecordRepayment,
  onSettleAll,
}: {
  tx: Transaction
  category: Category | undefined
  account: PaymentAccount | undefined
  trip: Trip | undefined
  showDateBadge?: boolean
  onEdit: (tx: Transaction) => void
  onDelete: (tx: Transaction) => void
  onRecordRepayment?: (tx: Transaction, share: SplitShare) => void
  onSettleAll?: (tx: Transaction) => void
}) {
  const [showActions, setShowActions] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const payMeta = getPaymentMeta(tx.paymentMode)
  const catMeta = getCategoryMeta(category?.name ?? 'Other')
  const accMeta = account ? getAccountTypeMeta(account.type) : null

  const recoverablePaise = getRecoverablePaise(tx)
  const isRecoverable = recoverablePaise > 0 || tx.type === 'reimbursable'
  const netSpendPaise = getNetSpendPaise(tx)
  const repaidPaise = getRepaidPaise(tx)
  const pendingPaise = getPendingRecoverablePaise(tx)
  const status = getReimbursementStatus(tx)
  const splits = getNormalizedSplits(tx)

  return (
    <div
      className="group relative flex flex-col px-3.5 py-3 transition-all hover:bg-[var(--surface-2)]/70 cursor-pointer"
      onClick={() => {
        if (isRecoverable) {
          setExpanded(v => !v)
        }
        setShowActions(v => !v)
      }}
    >
      <div className="flex items-center gap-3 w-full">
        {/* Category icon */}
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg"
          style={{ backgroundColor: catMeta.color + '20' }}
        >
          {catMeta.emoji}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="truncate text-sm font-medium text-[var(--text-primary)]">
              {tx.description}
            </p>
            <TypeBadge type={tx.type} />
            {isRecoverable && <ReimbursementBadge status={status} />}
            {tx.isImported && (
              <span
                className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--text-subtle)]"
                title="Imported from Excel"
              >
                Excel
              </span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {showDateBadge && tx.date && (() => {
              const d = parseTransactionDate(tx.date)
              return d ? (
                <span className="text-[10px] font-medium text-[var(--text-muted)]">
                  {format(d, 'd MMM')} ·
                </span>
              ) : null
            })()}
            {/* Payment mode badge */}
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ backgroundColor: payMeta.bgColor, color: payMeta.color }}
            >
              {tx.paymentMode}
            </span>
            {/* Linked payment account */}
            {account && accMeta && (
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: accMeta.bgColor, color: accMeta.color }}
              >
                {account.name}
              </span>
            )}
            {/* Category name */}
            {category && (
              <span className="text-[10px] text-[var(--text-subtle)]">{category.name}</span>
            )}
            {/* Linked trip pill (when not inside a collapsed trip bundle) */}
            {trip && !showDateBadge && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--primary-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--primary)]">
                <span>{trip.coverEmoji}</span>
                <span className="truncate max-w-[110px]">{trip.name}</span>
              </span>
            )}
            {/* Participant summary in row */}
            {splits.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)] truncate max-w-[180px]">
                <Users className="h-2.5 w-2.5 shrink-0 text-[var(--text-subtle)]" />
                <span>{splits.map(s => s.personName).join(', ')}</span>
              </span>
            ) : tx.personId ? (
              <span className="text-[10px] text-[var(--text-muted)]">· 👤 {tx.personId}</span>
            ) : null}
            {tx.notes && (
              <span className="truncate max-w-[140px] text-[10px] italic text-[var(--text-subtle)]">
                · “{tx.notes}”
              </span>
            )}
          </div>
        </div>

        {/* Amount */}
        <div className="flex shrink-0 flex-col items-end">
          {isRecoverable ? (
            <>
              <div className="flex items-center gap-1">
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                  {netSpendPaise === 0 ? '₹0' : formatTxAmount(netSpendPaise)}
                </span>
                <span className="text-[10px] font-medium text-[var(--text-muted)]">net</span>
              </div>
              <span className="text-[10px] text-[var(--text-subtle)]">
                Gross {formatTxAmount(tx.amountPaise)}
              </span>
            </>
          ) : (
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              {formatTxAmount(tx.amountPaise)}
            </span>
          )}
        </div>

        {/* Actions: collapsed when idle so amount stays flush-right */}
        <div
          className={`items-center gap-1 ${
            showActions ? 'flex' : 'hidden group-hover:flex'
          }`}
        >
          <button
            onClick={e => {
              e.stopPropagation()
              onEdit(tx)
            }}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--primary)] transition-colors"
            aria-label="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={e => {
              e.stopPropagation()
              onDelete(tx)
            }}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] transition-colors"
            aria-label="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Expand/Collapse Chevron indicator for recoverable transactions */}
        {isRecoverable && (
          <div className="shrink-0 text-[var(--text-muted)]">
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </div>
        )}
      </div>

      {/* Expandable details when shared/recoverable */}
      {expanded && isRecoverable && (
        <div
          onClick={e => e.stopPropagation()}
          className="mt-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/60 p-3 text-xs"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-1 text-[11px] text-[var(--text-secondary)]">
            <span className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
              <Users className="h-3.5 w-3.5 text-[var(--primary)]" />
              <span>Split Breakdown</span>
              <ReimbursementBadge status={status} />
            </span>
            <div className="flex items-center gap-2">
              <span>
                Recoverable: <strong className="text-[var(--text-primary)]">{formatINR(recoverablePaise)}</strong>
                {repaidPaise > 0 && (
                  <span className="ml-1 text-[var(--success)]">· {formatINR(repaidPaise)} repaid</span>
                )}
                {pendingPaise > 0 ? (
                  <span className="ml-1 text-[var(--warning)]">({formatINR(pendingPaise)} due)</span>
                ) : (
                  <span className="ml-1 text-[var(--success)]">(All settled)</span>
                )}
              </span>
              {pendingPaise > 0 && onSettleAll && (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    onSettleAll(tx)
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-[var(--success)]/40 bg-[var(--success-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--success)] hover:bg-[var(--success)] hover:text-white transition-colors"
                  title="Settle all dues for this transaction"
                >
                  <Check className="h-3 w-3" /> Settle All
                </button>
              )}
            </div>
          </div>

          <div className="space-y-1.5 divide-y divide-[var(--border)]/60">
            {splits.map(s => {
              const friendPending = s.amountPaise - s.repaidPaise
              const isFriendSettled = s.repaidPaise === s.amountPaise && s.amountPaise > 0
              return (
                <div key={s.personId} className="flex items-center justify-between pt-1.5 first:pt-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium text-[var(--text-primary)] truncate">
                      {s.personName}
                    </span>
                    {isFriendSettled ? (
                      <span className="rounded bg-[var(--success-muted)] px-1.5 py-0.2 text-[9px] font-semibold text-[var(--success)]">
                        Settled
                      </span>
                    ) : s.repaidPaise > 0 ? (
                      <span className="rounded bg-[var(--primary-muted)] px-1.5 py-0.2 text-[9px] font-semibold text-[var(--primary)]">
                        {formatINR(s.repaidPaise)} repaid
                      </span>
                    ) : (
                      <span className="rounded bg-[var(--warning-muted)] px-1.5 py-0.2 text-[9px] font-semibold text-[var(--warning)]">
                        Unpaid
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-right shrink-0">
                    <div>
                      <span className="font-semibold text-[var(--text-primary)]">
                        {formatINR(s.amountPaise)}
                      </span>
                      {friendPending > 0 && s.repaidPaise > 0 && (
                        <span className="ml-1 text-[10px] text-[var(--warning)]">
                          ({formatINR(friendPending)} due)
                        </span>
                      )}
                    </div>
                    {friendPending > 0 && onRecordRepayment && (
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation()
                          onRecordRepayment(tx, s)
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--primary)]/30 bg-[var(--primary-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--primary)] hover:bg-[var(--primary)] hover:text-white transition-all active:scale-95"
                        title={`Record repayment from ${s.personName}`}
                      >
                        Repay
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {netSpendPaise > 0 && (
            <div className="mt-2.5 flex items-center justify-between border-t border-[var(--border)] pt-2 text-[11px] text-[var(--text-muted)]">
              <span>My personal share (absorbed by me)</span>
              <span className="font-semibold text-[var(--text-primary)]">
                {formatINR(netSpendPaise)}
              </span>
            </div>
          )}

          {tx.receiptUrl && (
            <div className="mt-2 flex items-center gap-1 text-[11px] text-[var(--primary)]">
              <ExternalLink className="h-3 w-3" />
              <a
                href={tx.receiptUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                View attached receipt
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Collapsible Trip Bundle Row ──────────────────────────────────────────────

function TripBundleRow({
  tripId,
  trip,
  items,
  totalPaise,
  expanded,
  onToggle,
  getCat,
  getAcc,
  onEdit,
  onDelete,
  onOpenTrip,
  onRecordRepayment,
  onSettleAll,
}: {
  tripId: string
  trip: Trip | undefined
  items: Transaction[]
  totalPaise: number
  expanded: boolean
  onToggle: () => void
  getCat: (id: string) => Category | undefined
  getAcc: (id: string | null) => PaymentAccount | undefined
  onEdit: (tx: Transaction) => void
  onDelete: (tx: Transaction) => void
  onOpenTrip: (tripId: string) => void
  onRecordRepayment?: (tx: Transaction, share: SplitShare) => void
  onSettleAll?: (tx: Transaction) => void
}) {
  const tripName = trip?.name ?? 'Trip Expenses'
  const tripEmoji = trip?.coverEmoji ?? '✈️'
  const tripColor = trip?.coverColor ?? '#06B6D4'

  const dateRangeLabel = useMemo(() => {
    if (trip?.startDate) {
      const s = parseTransactionDate(trip.startDate)
      const e = trip.endDate ? parseTransactionDate(trip.endDate) : null
      if (s) {
        return e ? `${format(s, 'd MMM')} – ${format(e, 'd MMM yyyy')}` : format(s, 'd MMM yyyy')
      }
    }
    return `${items.length} expenses`
  }, [trip, items.length])

  return (
    <div className="bg-[var(--surface)]">
      {/* Summary row for the entire trip */}
      <div
        onClick={onToggle}
        className="flex cursor-pointer items-center gap-3 px-3.5 py-3 transition-colors hover:bg-[var(--surface-2)]/70"
      >
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg"
          style={{ backgroundColor: tripColor + '22' }}
        >
          {tripEmoji}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
              {tripName}
            </p>
            <span className="badge-trip inline-block shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none">
              {items.length} items
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <span>{dateRangeLabel}</span>
            <span>·</span>
            <span className="text-[var(--primary)] font-medium">
              {expanded ? 'Hide split-up' : 'Click to view split-up'}
            </span>
            {trip && (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation()
                  onOpenTrip(tripId)
                }}
                className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--primary)]"
              >
                Trip page <ExternalLink className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <span className="text-sm font-bold text-[var(--text-primary)]">
              {formatINR(totalPaise)}
            </span>
          </div>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-[var(--text-muted)]" />
          ) : (
            <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
          )}
        </div>
      </div>

      {/* Expanded split-up rows */}
      {expanded && (
        <div className="border-t border-[var(--border)] bg-[var(--surface-2)]/40 pl-3 divide-y divide-[var(--border)]">
          {items.map(tx => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              category={getCat(tx.categoryId)}
              account={getAcc(tx.paymentAccountId)}
              trip={trip}
              showDateBadge
              onEdit={onEdit}
              onDelete={onDelete}
              onRecordRepayment={onRecordRepayment}
              onSettleAll={onSettleAll}
            />
          ))}
        </div>
      )}
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
  onConfirm: () => Promise<void>
  onCancel: () => void
}) {
  const pendingRecoverablePaise = getPendingRecoverablePaise(tx)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  let protectionMessage: string | null = null
  try {
    assertExpenseCanBeDeleted(tx)
  } catch (err) {
    protectionMessage = err instanceof ExpenseDeletionError ? err.message : 'Repayment history could not be verified.'
  }

  async function confirmDelete() {
    if (inFlight.current) return
    inFlight.current = true
    setDeleting(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof ExpenseDeletionError ? err.message : 'Could not delete this expense. Refresh and try again.')
    } finally {
      inFlight.current = false
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => { if (!inFlight.current) onCancel() }} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-xl)]">
        <h3 className="mb-2 text-base font-semibold text-[var(--text-primary)]">Delete expense?</h3>
        <p className="mb-4 text-sm text-[var(--text-muted)]">
          “{tx.description}” — {formatTxAmount(tx.amountPaise)}{protectionMessage ? '' : ' will be permanently deleted.'}
        </p>

        {!protectionMessage && pendingRecoverablePaise > 0 && (
          <div className="mb-4 rounded-xl border border-[var(--warning)]/30 bg-[var(--warning-muted)] p-3 text-xs text-[var(--text-secondary)]">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-[var(--warning)]">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>Active Split Dues ({formatTxAmount(pendingRecoverablePaise)})</span>
            </div>
            <p className="leading-relaxed">
              Friends currently owe you <strong>{formatTxAmount(pendingRecoverablePaise)}</strong> on this bill. Deleting
              this expense will permanently erase these dues from your Split Book ledger.
            </p>
          </div>
        )}

        {(error || protectionMessage) && <p role="alert" className="mb-4 text-sm text-[var(--danger)]">{error || protectionMessage}</p>}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="flex-1 rounded-xl border border-[var(--border)] py-2.5 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--surface-2)] transition-colors"
          >
            {protectionMessage ? 'Close' : 'Cancel'}
          </button>
          <button
            onClick={confirmDelete}
            disabled={deleting || !!protectionMessage}
            className="flex-1 rounded-xl bg-[var(--danger)] py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
          >
            {deleting ? 'Checking…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Repayment modal ──────────────────────────────────────────────────────────

interface RepaymentModalProps {
  tx: Transaction
  share: SplitShare
  onClose: () => void
  onSuccess: (updatedTx: Transaction, appliedPaise: number) => void
}

function RepaymentModal({ tx, share, onClose, onSuccess }: RepaymentModalProps) {
  const { user } = useAuth()
  const outstandingPaise = Math.max(0, share.amountPaise - share.repaidPaise)
  const [rupees, setRupees] = useState((outstandingPaise / 100).toFixed(2))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsedPaise = Math.round(Number(rupees || '0') * 100)
  const isFull = parsedPaise === outstandingPaise

  async function handleConfirm() {
    if (!user) return
    if (!parsedPaise || parsedPaise <= 0 || !Number.isInteger(parsedPaise)) {
      setError('Please enter a valid repayment amount greater than 0')
      return
    }
    if (parsedPaise > outstandingPaise) {
      setError(`Repayment cannot exceed the outstanding balance of ₹${(outstandingPaise / 100).toFixed(2)}`)
      return
    }

    setLoading(true)
    setError(null)
    try {
      let res: { tx: Transaction; appliedPaise?: number; settledPaise?: number }
      if (isFull) {
        const sRes = await settleSplitShare(user.uid, tx.id, share.personId)
        res = { tx: sRes.tx, appliedPaise: sRes.settledPaise }
      } else {
        const rRes = await recordSplitRepayment(user.uid, tx.id, share.personId, parsedPaise)
        res = { tx: rRes.tx, appliedPaise: rRes.appliedPaise }
      }
      onSuccess(res.tx, res.appliedPaise ?? parsedPaise)
    } catch (err: any) {
      console.error('[Spenza] Repayment error:', err)
      setError(err?.message || 'Failed to record repayment')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-xl)]">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--primary-muted)] text-[var(--primary)]">
              <Users className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[var(--text-primary)]">Record Repayment</h3>
              <p className="text-xs text-[var(--text-muted)] truncate max-w-[200px]">{tx.description}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Participant & balance overview */}
        <div className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">Participant</span>
            <span className="text-xs font-bold text-[var(--text-primary)]">{share.personName}</span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1 border-t border-[var(--border)] pt-2 text-center text-xs">
            <div>
              <p className="text-[10px] text-[var(--text-subtle)]">Total Share</p>
              <p className="font-semibold text-[var(--text-primary)]">{formatINR(share.amountPaise)}</p>
            </div>
            <div>
              <p className="text-[10px] text-[var(--text-subtle)]">Already Repaid</p>
              <p className="font-semibold text-[var(--success)]">{formatINR(share.repaidPaise)}</p>
            </div>
            <div>
              <p className="text-[10px] text-[var(--text-subtle)]">Pending Due</p>
              <p className="font-bold text-[var(--warning)]">{formatINR(outstandingPaise)}</p>
            </div>
          </div>
        </div>

        {/* Amount Input */}
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
            Repayment Amount Received
          </label>
          <div className="relative flex items-center">
            <span className="absolute left-3.5 font-bold text-[var(--text-muted)]">₹</span>
            <input
              type="number"
              step="any"
              min="0.01"
              max={(outstandingPaise / 100).toFixed(2)}
              value={rupees}
              onChange={e => {
                setRupees(e.target.value)
                setError(null)
              }}
              placeholder="0.00"
              autoFocus
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-3 py-2.5 text-base font-semibold text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
            />
          </div>

          {/* Quick presets */}
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setRupees((outstandingPaise / 100).toFixed(2))
                setError(null)
              }}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
            >
              Full due ({formatINR(outstandingPaise)})
            </button>
            {outstandingPaise >= 200 && (
              <button
                type="button"
                onClick={() => {
                  setRupees((Math.floor(outstandingPaise / 2) / 100).toFixed(2))
                  setError(null)
                }}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
              >
                Half (₹{(Math.floor(outstandingPaise / 2) / 100).toFixed(2)})
              </button>
            )}
          </div>

          {error && (
            <p className="mt-2 text-xs font-medium text-[var(--danger)]">{error}</p>
          )}
        </div>

        {/* Modal Actions */}
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-xl border border-[var(--border)] py-2.5 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-[var(--primary)] py-2.5 text-sm font-semibold text-white hover:bg-[var(--primary-hover)] transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {isFull ? 'Settle in Full' : 'Save Repayment'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Settle All Modal ─────────────────────────────────────────────────────────

interface SettleAllModalProps {
  tx: Transaction
  onClose: () => void
  onSuccess: (updatedTx: Transaction, settledPaise: number) => void
}

function SettleAllModal({ tx, onClose, onSuccess }: SettleAllModalProps) {
  const { user } = useAuth()
  const pendingPaise = getPendingRecoverablePaise(tx)
  const splits = getNormalizedSplits(tx)
  const unsettledSplits = splits.filter(s => s.amountPaise > s.repaidPaise)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      const res = await settleAllTransactionSplits(user.uid, tx.id)
      onSuccess(res.tx, res.settledPaise)
    } catch (err: any) {
      console.error('[Spenza] Settle all error:', err)
      setError(err?.message || 'Failed to settle all shares')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-xl)]">
        <div className="mb-3 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--success-muted)] text-[var(--success)]">
            <Check className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-[var(--text-primary)]">Settle All Dues?</h3>
            <p className="text-xs text-[var(--text-muted)] truncate max-w-[200px]">{tx.description}</p>
          </div>
        </div>

        <p className="mb-3 text-xs text-[var(--text-secondary)]">
          Mark all remaining balances as fully paid for this transaction. This will settle:
        </p>

        <div className="mb-4 space-y-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs">
          {unsettledSplits.map(s => (
            <div key={s.personId} className="flex items-center justify-between">
              <span className="font-medium text-[var(--text-primary)]">{s.personName}</span>
              <span className="font-bold text-[var(--warning)]">{formatINR(s.amountPaise - s.repaidPaise)}</span>
            </div>
          ))}
          <div className="border-t border-[var(--border)] pt-1.5 flex items-center justify-between font-bold text-[var(--text-primary)]">
            <span>Total to Settle</span>
            <span className="text-[var(--success)]">{formatINR(pendingPaise)}</span>
          </div>
        </div>

        {error && (
          <p className="mb-3 text-xs font-medium text-[var(--danger)]">{error}</p>
        )}

        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-xl border border-[var(--border)] py-2.5 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-[var(--success)] py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Confirm Settle All
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Settle Person All Dues Modal ─────────────────────────────────────────────

interface SettlePersonModalProps {
  person: PersonDuesSummary
  transactions: Transaction[]
  onClose: () => void
  onSuccess: (updatedTxns: Transaction[], settledCount: number, totalSettledPaise: number) => void
}

function SettlePersonModal({
  person,
  transactions,
  onClose,
  onSuccess,
}: SettlePersonModalProps) {
  const { user } = useAuth()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const personTxns = transactions.filter(tx => {
    const splits = getNormalizedSplits(tx)
    const share = splits.find(
      s =>
        s.personId === person.personId ||
        (s.personId === UNASSIGNED_PERSON_ID &&
          s.personName.toLowerCase() === person.personName.toLowerCase())
    )
    return share && share.amountPaise > share.repaidPaise
  })

  async function handleConfirm() {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      const res = await settlePersonAllDues(user.uid, person.personId)
      onSuccess(res.updatedTxns, res.settledCount, res.totalSettledPaise)
    } catch (err: any) {
      console.error('[Spenza] Settle person error:', err)
      setError(err?.message || 'Failed to settle all dues for this person')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-xl)]">
        <div className="mb-3 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--success-muted)] text-[var(--success)]">
            <Check className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-[var(--text-primary)]">
              Settle All with {person.personName}?
            </h3>
            <p className="text-xs text-[var(--text-muted)]">
              {person.unsettledTxnCount} unsettled {person.unsettledTxnCount === 1 ? 'bill' : 'bills'}
            </p>
          </div>
        </div>

        <p className="mb-3 text-xs text-[var(--text-secondary)]">
          Mark all outstanding shares for <strong>{person.personName}</strong> as fully settled:
        </p>

        <div className="mb-4 max-h-48 overflow-y-auto space-y-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs">
          {personTxns.map(tx => {
            const splits = getNormalizedSplits(tx)
            const share = splits.find(
              s =>
                s.personId === person.personId ||
                (s.personId === UNASSIGNED_PERSON_ID &&
                  s.personName.toLowerCase() === person.personName.toLowerCase())
            )
            const due = share ? share.amountPaise - share.repaidPaise : 0
            return (
              <div key={tx.id} className="flex items-center justify-between py-0.5">
                <span className="truncate max-w-[190px] font-medium text-[var(--text-primary)]">
                  {tx.description}
                </span>
                <span className="font-bold text-[var(--warning)]">{formatINR(due)}</span>
              </div>
            )
          })}
          <div className="border-t border-[var(--border)] pt-1.5 flex items-center justify-between font-bold text-[var(--text-primary)]">
            <span>Total to Settle</span>
            <span className="text-[var(--success)]">{formatINR(person.pendingDuesPaise)}</span>
          </div>
        </div>

        {error && (
          <p className="mb-3 text-xs font-medium text-[var(--danger)]">{error}</p>
        )}

        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-xl border border-[var(--border)] py-2.5 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-[var(--success)] py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Confirm Settle All
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function TransactionsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [accounts, setAccounts] = useState<PaymentAccount[]>([])
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(true)

  // Filters & search state
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedMonth, setSelectedMonth] = useState<string>('all')
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all')
  const initialFilter = searchParams.get('filter') || searchParams.get('type') || 'all'
  const [selectedTypeFilter, setSelectedTypeFilter] = useState<string>(initialFilter)
  const initialPerson = searchParams.get('person') || searchParams.get('personId') || null
  const [selectedPersonFilter, setSelectedPersonFilter] = useState<string | null>(initialPerson)
  const [selectedModeFilter, setSelectedModeFilter] = useState<string>('all')
  const [collapseTrips, setCollapseTrips] = useState(true)
  const [expandedTripIds, setExpandedTripIds] = useState<Record<string, boolean>>({})
  const [visibleGroupCount, setVisibleGroupCount] = useState(VISIBLE_GROUPS_STEP)

  // Drawer, delete & repayment modal state
  const [formOpen, setFormOpen] = useState(false)
  const [editTx, setEditTx] = useState<Transaction | null>(null)
  const [deleteTx, setDeleteTx] = useState<Transaction | null>(null)
  const [repaymentTarget, setRepaymentTarget] = useState<{ tx: Transaction; share: SplitShare } | null>(null)
  const [settleAllTarget, setSettleAllTarget] = useState<Transaction | null>(null)
  const [settlePersonTarget, setSettlePersonTarget] = useState<PersonDuesSummary | null>(null)
  const { notice, showNotice: showToast, dismiss } = useNotice()
  const [isFromCache, setIsFromCache] = useState(false)

  useEffect(() => {
    const filterParam = searchParams.get('filter') || searchParams.get('type')
    if (filterParam) {
      setSelectedTypeFilter(filterParam)
    }
    const personParam = searchParams.get('person') || searchParams.get('personId')
    if (personParam) {
      setSelectedPersonFilter(personParam)
    }
  }, [searchParams])

  const loadAll = useCallback(async () => {
    if (!user) return
    setLoading(true)
    try {
      // Loading the ledger must never clean up or delete persisted transactions.
      let [txs, cats, accs, tripList] = await Promise.all([
        getAllTransactions(user.uid),
        getCategories(user.uid),
        getPaymentAccounts(user.uid),
        getTrips(user.uid),
      ])
      if (cats.length === 0) {
        await seedCategories(user.uid)
        cats = await getCategories(user.uid)
      }
      if (accs.length === 0) {
        await seedPaymentAccounts(user.uid)
        accs = await getPaymentAccounts(user.uid)
      }
      setTransactions(txs)
      if (typeof setIsFromCache === 'function') {
        setIsFromCache(Boolean((txs as any)?.fromCache))
      }
      setCategories(cats)
      setAccounts(accs)
      setTrips(tripList)
    } finally {
      setLoading(false)
    }
  }, [user])

  const { isOnline, isStale } = useFinancialSync({
    uid: user?.uid,
    onRefresh: loadAll,
    isFromCache,
  })

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // Reset pagination window whenever filters change
  useEffect(() => {
    setVisibleGroupCount(VISIBLE_GROUPS_STEP)
  }, [searchQuery, selectedMonth, selectedCategoryId, selectedTypeFilter, selectedPersonFilter, selectedModeFilter, collapseTrips])

  const handleSuccess = useCallback(() => {
    // Close drawer automatically after editing an existing transaction
    if (editTx) {
      setFormOpen(false)
      setEditTx(null)
    }
    loadAll()
  }, [editTx, loadAll])

  const handleDelete = useCallback(async () => {
    if (!user || !deleteTx) return
    await deleteTransaction(user.uid, deleteTx.id)
    setDeleteTx(null)
    loadAll()
  }, [user, deleteTx, loadAll])

  const handleOpenRepayment = useCallback((tx: Transaction, share: SplitShare) => {
    setRepaymentTarget({ tx, share })
  }, [])

  const handleOpenSettleAll = useCallback((tx: Transaction) => {
    setSettleAllTarget(tx)
  }, [])

  const handleRepaymentSuccess = useCallback((updatedTx: Transaction, appliedPaise: number) => {
    const name = repaymentTarget?.share.personName || 'participant'
    setRepaymentTarget(null)
    setTransactions(prev => prev.map(t => (t.id === updatedTx.id ? updatedTx : t)))
    showToast(`Recorded ${formatINR(appliedPaise)} repayment from ${name} ✓`)
    loadAll()
  }, [repaymentTarget, showToast, loadAll])

  const handleSettleAllSuccess = useCallback((updatedTx: Transaction, settledPaise: number) => {
    setSettleAllTarget(null)
    setTransactions(prev => prev.map(t => (t.id === updatedTx.id ? updatedTx : t)))
    showToast(`All dues settled (${formatINR(settledPaise)}) ✓`)
    loadAll()
  }, [showToast, loadAll])

  const handleSettlePersonSuccess = useCallback(
    (updatedTxns: Transaction[], settledCount: number, totalSettledPaise: number) => {
      const pName = settlePersonTarget?.personName || 'friend'
      setSettlePersonTarget(null)
      const updatedMap = new Map(updatedTxns.map(t => [t.id, t]))
      setTransactions(prev => prev.map(t => updatedMap.get(t.id) || t))
      showToast(
        `Settled all dues with ${pName} (${formatINR(totalSettledPaise)} across ${settledCount} ${
          settledCount === 1 ? 'bill' : 'bills'
        }) ✓`
      )
      loadAll()
    },
    [settlePersonTarget, showToast, loadAll]
  )

  const peopleDues = useMemo(() => aggregatePeopleDues(transactions), [transactions])
  const unsettledPeople = useMemo(
    () => peopleDues.filter(p => p.pendingDuesPaise > 0),
    [peopleDues]
  )

  const catMap = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories])
  const accMap = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])
  const tripMap = useMemo(() => new Map(trips.map(t => [t.id, t])), [trips])

  const getCat = useCallback((id: string) => catMap.get(id), [catMap])
  const getAcc = useCallback((id: string | null) => (id ? accMap.get(id) : undefined), [accMap])

  // Available months derived from all transactions
  const availableMonths = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const tx of transactions) {
      const d = parseTransactionDate(tx.date)
      if (!d) continue
      const key = format(d, 'yyyy-MM')
      const existing = counts.get(key)
      if (existing) {
        existing.count++
      } else {
        counts.set(key, { label: format(d, 'MMMM yyyy'), count: 1 })
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, info]) => ({ key, ...info }))
  }, [transactions])

  // Filtered transactions
  const filteredTransactions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return transactions.filter(tx => {
      if (selectedMonth !== 'all') {
        const d = parseTransactionDate(tx.date)
        if (!d || format(d, 'yyyy-MM') !== selectedMonth) return false
      }
      if (selectedCategoryId !== 'all' && tx.categoryId !== selectedCategoryId) {
        return false
      }
      if (selectedTypeFilter !== 'all') {
        if (selectedTypeFilter === 'imported') {
          if (!tx.isImported) return false
        } else if (selectedTypeFilter === 'manual') {
          if (tx.isImported) return false
        } else if (selectedTypeFilter === 'shared') {
          if (!isSplitOrRecoverable(tx)) return false
        } else if (selectedTypeFilter === 'pending_dues') {
          const status = getReimbursementStatus(tx)
          if (status !== 'pending' && status !== 'partial') return false
        } else if (tx.type !== selectedTypeFilter) {
          return false
        }
      }
      if (selectedPersonFilter) {
        const pLower = selectedPersonFilter.toLowerCase()
        const splits = getNormalizedSplits(tx)
        const match =
          splits.some(
            s =>
              s.personName.toLowerCase() === pLower ||
              s.personId.toLowerCase() === pLower
          ) || (tx.personId && tx.personId.toLowerCase() === pLower)
        if (!match) return false
      }
      if (selectedModeFilter !== 'all' && tx.paymentMode !== selectedModeFilter) {
        return false
      }
      if (q) {
        const catName = catMap.get(tx.categoryId)?.name?.toLowerCase() ?? ''
        const accName = (tx.paymentAccountId ? accMap.get(tx.paymentAccountId)?.name : '')?.toLowerCase() ?? ''
        const tripName = (tx.tripId ? tripMap.get(tx.tripId)?.name : '')?.toLowerCase() ?? ''
        const desc = (tx.description ?? '').toLowerCase()
        const notes = (tx.notes ?? '').toLowerCase()
        const person = (tx.personId ?? '').toLowerCase()
        const splitPeople = (tx.splits ?? []).map(s => s.personName).join(' ').toLowerCase()
        if (
          !desc.includes(q) &&
          !catName.includes(q) &&
          !accName.includes(q) &&
          !tripName.includes(q) &&
          !notes.includes(q) &&
          !person.includes(q) &&
          !splitPeople.includes(q)
        ) {
          return false
        }
      }
      return true
    })
  }, [
    transactions,
    selectedMonth,
    selectedCategoryId,
    selectedTypeFilter,
    selectedPersonFilter,
    selectedModeFilter,
    searchQuery,
    catMap,
    accMap,
    tripMap,
  ])

  const hasActiveFilters =
    searchQuery.trim() !== '' ||
    selectedMonth !== 'all' ||
    selectedCategoryId !== 'all' ||
    selectedTypeFilter !== 'all' ||
    selectedPersonFilter !== null ||
    selectedModeFilter !== 'all'

  const resetFilters = () => {
    setSearchQuery('')
    setSelectedMonth('all')
    setSelectedCategoryId('all')
    setSelectedTypeFilter('all')
    setSelectedPersonFilter(null)
    setSelectedModeFilter('all')
  }

  // Auto-expand trip rows when user is searching text or filtering by a specific category
  const effectiveCollapseTrips =
    collapseTrips && searchQuery.trim() === '' && selectedCategoryId === 'all'

  const allGroups = useMemo(
    () => buildDateGroups(filteredTransactions, tripMap, effectiveCollapseTrips),
    [filteredTransactions, tripMap, effectiveCollapseTrips]
  )

  const visibleGroups = useMemo(
    () => allGroups.slice(0, visibleGroupCount),
    [allGroups, visibleGroupCount]
  )
  const hasMoreGroups = visibleGroupCount < allGroups.length

  const totalPaise = useMemo(
    () => filteredTransactions.reduce((sum, tx) => sum + tx.amountPaise, 0),
    [filteredTransactions]
  )

  const totalNetPaise = useMemo(
    () => filteredTransactions.reduce((sum, tx) => sum + getNetSpendPaise(tx), 0),
    [filteredTransactions]
  )

  const totalRecoverablePaise = useMemo(
    () => filteredTransactions.reduce((sum, tx) => sum + getRecoverablePaise(tx), 0),
    [filteredTransactions]
  )

  const hasAnyTripTransactions = useMemo(
    () => filteredTransactions.some(tx => !!tx.tripId),
    [filteredTransactions]
  )

  return (
    <div className="pb-20 md:pb-6">
      <Notification notice={notice} onDismiss={dismiss} />
      {/* Header row */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-[var(--text-primary)]">Transactions</h1>
            {isStale ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--warning-muted)] px-2 py-0.5 text-xs font-medium text-[var(--warning)]">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Updating…
              </span>
            ) : (!isOnline || isFromCache) ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-[var(--warning-muted)] px-2 py-0.5 text-xs font-medium text-[var(--warning)]"
                title="Ledger reflects local offline cache. Fresh data will sync when online."
              >
                <WifiOff className="h-3 w-3" />
                Cached offline ledger
              </span>
            ) : null}
          </div>
          {!loading && (
            <p className="mt-0.5 text-sm text-[var(--text-muted)]">
              {filteredTransactions.length.toLocaleString('en-IN')}{' '}
              {filteredTransactions.length === 1 ? 'entry' : 'entries'}
              {hasActiveFilters ? ' (filtered)' : ''} ·{' '}
              <span className="font-semibold text-[var(--text-primary)]">
                {formatINR(totalPaise)}
              </span>{' '}
              total
              {totalRecoverablePaise > 0 && (
                <span className="text-xs text-[var(--text-muted)] font-normal ml-1">
                  ({formatINR(totalNetPaise)} net spend · {formatINR(totalRecoverablePaise)} recoverable)
                </span>
              )}
            </p>
          )}
        </div>
        <button
          id="add-expense-fab-desktop"
          onClick={() => {
            setEditTx(null)
            setFormOpen(true)
          }}
          className="flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-md)] transition-all hover:bg-[var(--primary-hover)] active:scale-[0.97]"
        >
          <Plus className="h-4 w-4" />
          Add Expense
        </button>
      </div>

      {/* Search & Filter Bar */}
      {!loading && transactions.length > 0 && (
        <div className="mb-5 flex flex-col gap-2.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5 shadow-[var(--shadow-sm)]">
          {/* Row 1: Search input + Trip grouping toggle */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search description, category, trip, account…"
                className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] pl-9 pr-8 py-2 text-xs sm:text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-subtle)] focus:border-[var(--primary)]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {hasAnyTripTransactions && (
              <button
                type="button"
                onClick={() => setCollapseTrips(v => !v)}
                title="Bundle all expenses of a trip into a single expandable summary row"
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-all ${
                  collapseTrips
                    ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]'
                    : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                <span>Group Trips</span>
              </button>
            )}

            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            )}
          </div>

          {/* Row 2: Month, Category, Type/Source, Payment Mode selectors */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ThemedSelect
              value={selectedMonth}
              onChange={setSelectedMonth}
              aria-label="Filter by month"
              className="w-full"
              options={[
                { value: 'all', label: `📅 All Months (${transactions.length})` },
                ...availableMonths.map(m => ({
                  value: m.key,
                  label: `${m.label} (${m.count})`,
                })),
              ]}
            />

            <ThemedSelect
              value={selectedCategoryId}
              onChange={setSelectedCategoryId}
              aria-label="Filter by category"
              className="w-full"
              options={[
                { value: 'all', label: '🏷️ All Categories' },
                ...categories
                  .filter(c => !c.isArchived)
                  .map(c => ({
                    value: c.id,
                    label: `${getCategoryMeta(c.name).emoji} ${c.name}`,
                  })),
              ]}
            />

            <ThemedSelect
              value={selectedTypeFilter}
              onChange={setSelectedTypeFilter}
              aria-label="Filter by expense type or source"
              className="w-full"
              options={[
                { value: 'all', label: '✨ All Types & Sources' },
                { value: 'imported', label: '📥 Excel Imported Only' },
                { value: 'manual', label: '✍️ Manually Logged Only' },
                { value: 'everyday', label: 'Everyday' },
                { value: 'trip', label: '✈️ Trip' },
                { value: 'recurring', label: 'Recurring' },
                { value: 'one-time', label: 'One-time' },
                { value: 'gift-event', label: 'Gift / Event' },
                { value: 'reimbursable', label: 'Reimbursable' },
                { value: 'shared', label: '👥 Shared / Splits' },
                { value: 'pending_dues', label: '⏳ Pending Dues' },
              ]}
            />

            <ThemedSelect
              value={selectedModeFilter}
              onChange={setSelectedModeFilter}
              aria-label="Filter by payment mode"
              className="w-full"
              options={[
                { value: 'all', label: '💳 All Payment Modes' },
                ...(['UPI', 'Cash', 'Card', 'Bank Transfer', 'Other'] as PaymentMode[]).map(m => ({
                  value: m,
                  label: m,
                })),
              ]}
            />
          </div>

          {/* Row 3: Friend Dues Pills when pending dues exist */}
          {unsettledPeople.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pt-1 pb-0.5">
              <span className="shrink-0 text-[11px] font-medium text-[var(--text-subtle)] mr-0.5">
                Friends with dues:
              </span>
              <button
                type="button"
                onClick={() => setSelectedPersonFilter(null)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all ${
                  selectedPersonFilter === null
                    ? 'bg-[var(--primary)] text-white shadow-xs'
                    : 'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'
                }`}
              >
                All Friends
              </button>
              {unsettledPeople.map(p => {
                const isSelected =
                  selectedPersonFilter?.toLowerCase() === p.personName.toLowerCase() ||
                  selectedPersonFilter === p.personId
                return (
                  <button
                    key={p.personId}
                    type="button"
                    onClick={() =>
                      setSelectedPersonFilter(isSelected ? null : p.personName)
                    }
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all ${
                      isSelected
                        ? 'bg-[var(--warning)] text-white shadow-xs'
                        : 'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'
                    }`}
                  >
                    <span>{p.personName}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.2 text-[9px] ${
                        isSelected
                          ? 'bg-black/20 text-white'
                          : 'bg-[var(--warning-muted)] text-[var(--warning)]'
                      }`}
                    >
                      {formatINR(p.pendingDuesPaise)}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Person settlement banner when a person is filtered */}
          {selectedPersonFilter && (() => {
            const p = unsettledPeople.find(
              u =>
                u.personName.toLowerCase() === selectedPersonFilter.toLowerCase() ||
                u.personId === selectedPersonFilter
            )
            if (!p || p.pendingDuesPaise <= 0) return null
            return (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning-muted)] px-3.5 py-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[var(--warning)]">
                    {p.personName} owes {formatINR(p.pendingDuesPaise)} across {p.unsettledTxnCount} {p.unsettledTxnCount === 1 ? 'bill' : 'bills'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSettlePersonTarget(p)}
                  className="inline-flex items-center gap-1 rounded-lg bg-[var(--warning)] px-2.5 py-1 text-xs font-bold text-white hover:opacity-95 active:scale-95 transition-all shadow-xs"
                >
                  <Check className="h-3.5 w-3.5" /> Settle All with {p.personName}
                </button>
              </div>
            )
          })()}
        </div>
      )}

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
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Tap “Add Expense” to log your first one
            </p>
          </div>
        </div>
      ) : filteredTransactions.length === 0 ? (
        <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-6 text-center">
          <Search className="h-9 w-9 text-[var(--text-subtle)]" />
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              No transactions match your filters
            </p>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Try clearing your search or switching the month/category filter.
            </p>
          </div>
          <button
            type="button"
            onClick={resetFilters}
            className="rounded-xl bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-white"
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {visibleGroups.map(({ label, entries, totalPaise: dayTotal }) => (
            <div key={label}>
              <div className="mb-2 flex items-center justify-between px-0.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {label}
                </h3>
                <span className="text-xs font-semibold text-[var(--text-secondary)]">
                  {formatINR(dayTotal)}
                </span>
              </div>
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden divide-y divide-[var(--border)]">
                {entries.map(entry =>
                  entry.kind === 'single' ? (
                    <TransactionRow
                      key={entry.tx.id}
                      tx={entry.tx}
                      category={getCat(entry.tx.categoryId)}
                      account={getAcc(entry.tx.paymentAccountId)}
                      trip={entry.tx.tripId ? tripMap.get(entry.tx.tripId) : undefined}
                      onEdit={tx => {
                        setEditTx(tx)
                        setFormOpen(true)
                      }}
                      onDelete={setDeleteTx}
                      onRecordRepayment={handleOpenRepayment}
                      onSettleAll={handleOpenSettleAll}
                    />
                  ) : (
                    <TripBundleRow
                      key={`trip-bundle-${entry.tripId}`}
                      tripId={entry.tripId}
                      trip={entry.trip}
                      items={entry.items}
                      totalPaise={entry.totalPaise}
                      expanded={!!expandedTripIds[entry.tripId]}
                      onToggle={() =>
                        setExpandedTripIds(prev => ({
                          ...prev,
                          [entry.tripId]: !prev[entry.tripId],
                        }))
                      }
                      getCat={getCat}
                      getAcc={getAcc}
                      onEdit={tx => {
                        setEditTx(tx)
                        setFormOpen(true)
                      }}
                      onDelete={setDeleteTx}
                      onOpenTrip={id => navigate(`/app/trips/${id}`)}
                      onRecordRepayment={handleOpenRepayment}
                      onSettleAll={handleOpenSettleAll}
                    />
                  )
                )}
              </div>
            </div>
          ))}

          {/* Show more date groups */}
          {hasMoreGroups && (
            <button
              type="button"
              onClick={() => setVisibleGroupCount(c => c + VISIBLE_GROUPS_STEP)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-3 text-sm font-medium text-[var(--text-muted)] transition-all hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              Show more ({allGroups.length - visibleGroupCount} more date groups)
            </button>
          )}
        </div>
      )}

      {/* FAB for mobile */}
      <button
        id="add-expense-fab-mobile"
        onClick={() => {
          setEditTx(null)
          setFormOpen(true)
        }}
        className="fixed bottom-20 right-5 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--primary)] shadow-[var(--shadow-lg)] transition-all hover:bg-[var(--primary-hover)] active:scale-95 md:hidden"
        aria-label="Add expense"
      >
        <Plus className="h-7 w-7 text-white" />
      </button>

      {/* Add/Edit drawer */}
      <Drawer
        open={formOpen}
        onClose={() => {
          setFormOpen(false)
          setEditTx(null)
        }}
      >
        <AddExpenseForm
          categories={categories}
          onSuccess={handleSuccess}
          onClose={() => {
            setFormOpen(false)
            setEditTx(null)
          }}
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

      {/* Repayment Modal */}
      {repaymentTarget && (
        <RepaymentModal
          tx={repaymentTarget.tx}
          share={repaymentTarget.share}
          onClose={() => setRepaymentTarget(null)}
          onSuccess={handleRepaymentSuccess}
        />
      )}

      {/* Settle All Modal */}
      {settleAllTarget && (
        <SettleAllModal
          tx={settleAllTarget}
          onClose={() => setSettleAllTarget(null)}
          onSuccess={handleSettleAllSuccess}
        />
      )}

      {/* Settle Person All Dues Modal */}
      {settlePersonTarget && (
        <SettlePersonModal
          person={settlePersonTarget}
          transactions={transactions}
          onClose={() => setSettlePersonTarget(null)}
          onSuccess={handleSettlePersonSuccess}
        />
      )}

    </div>
  )
}
