import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, isToday, isYesterday } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import {
  Plus, Trash2, Pencil, Loader2, Receipt, Search, X,
  ChevronDown, ChevronUp, ExternalLink, Layers, RotateCcw,
} from 'lucide-react'

import { useAuth } from '@/hooks/useAuth'
import {
  getAllTransactions,
  deleteTransaction,
  getCategories,
  getPaymentAccounts,
} from '@/services/transactions'
import { getTrips } from '@/services/trips'
import { deduplicateTripSummaryTransactions } from '@/services/importExcel'
import { getCategoryMeta } from '@/utils/categoryColors'
import { getPaymentMeta, getAccountTypeMeta } from '@/utils/paymentColors'
import { formatINR, formatINRExact } from '@/utils/format'
import { ThemedSelect } from '@/components/ui/ThemedSelect'
import { AddExpenseForm } from './AddExpenseForm'
import { Drawer } from '@/components/layout/Drawer'
import type { Transaction, Category, PaymentAccount, Trip, PaymentMode } from '@/types'

const VISIBLE_GROUPS_STEP = 15

/** Format transaction amount: exact 2 decimals if paise has fractional rupees (e.g. ₹451.97), else clean integer INR */
function formatTxAmount(paise: number): string {
  return Math.round(paise) % 100 === 0 ? formatINR(paise) : formatINRExact(paise)
}

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
    <span className={`${map[type] ?? ''} inline-block shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none`}>
      {labels[type] ?? type}
    </span>
  )
}

// ─── Date group helpers ───────────────────────────────────────────────────────

function dateLabel(ts: Timestamp): string {
  const d = ts?.toDate?.() ?? new Date()
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
      latestDate: Timestamp
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
}: {
  tx: Transaction
  category: Category | undefined
  account: PaymentAccount | undefined
  trip: Trip | undefined
  showDateBadge?: boolean
  onEdit: (tx: Transaction) => void
  onDelete: (tx: Transaction) => void
}) {
  const [showActions, setShowActions] = useState(false)
  const payMeta = getPaymentMeta(tx.paymentMode)
  const catMeta = getCategoryMeta(category?.name ?? 'Other')
  const accMeta = account ? getAccountTypeMeta(account.type) : null

  return (
    <div
      className="group relative flex items-center gap-3 px-3.5 py-3 transition-all hover:bg-[var(--surface-2)]/70"
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
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]">
            {tx.description}
          </p>
          <TypeBadge type={tx.type} />
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
          {showDateBadge && tx.date && (
            <span className="text-[10px] font-medium text-[var(--text-muted)]">
              {format((tx.date as Timestamp).toDate(), 'd MMM')} ·
            </span>
          )}
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
          {/* Person / notes indicator */}
          {tx.personId && (
            <span className="text-[10px] text-[var(--text-muted)]">· 👤 {tx.personId}</span>
          )}
          {tx.notes && (
            <span className="truncate max-w-[140px] text-[10px] italic text-[var(--text-subtle)]">
              · “{tx.notes}”
            </span>
          )}
        </div>
      </div>

      {/* Amount */}
      <div className="flex shrink-0 flex-col items-end">
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          {formatTxAmount(tx.amountPaise)}
        </span>
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
}) {
  const tripName = trip?.name ?? 'Trip Expenses'
  const tripEmoji = trip?.coverEmoji ?? '✈️'
  const tripColor = trip?.coverColor ?? '#06B6D4'

  const dateRangeLabel = useMemo(() => {
    if (trip?.startDate) {
      const s = (trip.startDate as Timestamp).toDate()
      const e = trip.endDate ? (trip.endDate as Timestamp).toDate() : null
      return e ? `${format(s, 'd MMM')} – ${format(e, 'd MMM yyyy')}` : format(s, 'd MMM yyyy')
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
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-xl)]">
        <h3 className="mb-2 text-base font-semibold text-[var(--text-primary)]">Delete expense?</h3>
        <p className="mb-5 text-sm text-[var(--text-muted)]">
          “{tx.description}” — {formatTxAmount(tx.amountPaise)} will be permanently deleted.
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
  const navigate = useNavigate()

  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [accounts, setAccounts] = useState<PaymentAccount[]>([])
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(true)

  // Filters & search state
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedMonth, setSelectedMonth] = useState<string>('all')
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all')
  const [selectedTypeFilter, setSelectedTypeFilter] = useState<string>('all')
  const [selectedModeFilter, setSelectedModeFilter] = useState<string>('all')
  const [collapseTrips, setCollapseTrips] = useState(true)
  const [expandedTripIds, setExpandedTripIds] = useState<Record<string, boolean>>({})
  const [visibleGroupCount, setVisibleGroupCount] = useState(VISIBLE_GROUPS_STEP)

  // Drawer & delete modal state
  const [formOpen, setFormOpen] = useState(false)
  const [editTx, setEditTx] = useState<Transaction | null>(null)
  const [deleteTx, setDeleteTx] = useState<Transaction | null>(null)

  const loadAll = useCallback(async () => {
    if (!user) return
    setLoading(true)
    try {
      await deduplicateTripSummaryTransactions(user.uid).catch(() => 0)
      const [txs, cats, accs, tripList] = await Promise.all([
        getAllTransactions(user.uid),
        getCategories(user.uid),
        getPaymentAccounts(user.uid),
        getTrips(user.uid),
      ])
      setTransactions(txs)
      setCategories(cats)
      setAccounts(accs)
      setTrips(tripList)
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // Reset pagination window whenever filters change
  useEffect(() => {
    setVisibleGroupCount(VISIBLE_GROUPS_STEP)
  }, [searchQuery, selectedMonth, selectedCategoryId, selectedTypeFilter, selectedModeFilter, collapseTrips])

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

  const catMap = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories])
  const accMap = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])
  const tripMap = useMemo(() => new Map(trips.map(t => [t.id, t])), [trips])

  const getCat = useCallback((id: string) => catMap.get(id), [catMap])
  const getAcc = useCallback((id: string | null) => (id ? accMap.get(id) : undefined), [accMap])

  // Available months derived from all transactions
  const availableMonths = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const tx of transactions) {
      const d = (tx.date as Timestamp)?.toDate?.()
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
        const d = (tx.date as Timestamp)?.toDate?.()
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
        } else if (tx.type !== selectedTypeFilter) {
          return false
        }
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
        if (
          !desc.includes(q) &&
          !catName.includes(q) &&
          !accName.includes(q) &&
          !tripName.includes(q) &&
          !notes.includes(q) &&
          !person.includes(q)
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
    selectedModeFilter !== 'all'

  const resetFilters = () => {
    setSearchQuery('')
    setSelectedMonth('all')
    setSelectedCategoryId('all')
    setSelectedTypeFilter('all')
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

  const hasAnyTripTransactions = useMemo(
    () => filteredTransactions.some(tx => !!tx.tripId),
    [filteredTransactions]
  )

  return (
    <div className="pb-20 md:pb-6">
      {/* Header row */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Transactions</h1>
          {!loading && (
            <p className="mt-0.5 text-sm text-[var(--text-muted)]">
              {filteredTransactions.length.toLocaleString('en-IN')}{' '}
              {filteredTransactions.length === 1 ? 'entry' : 'entries'}
              {hasActiveFilters ? ' (filtered)' : ''} ·{' '}
              <span className="font-semibold text-[var(--text-primary)]">
                {formatINR(totalPaise)}
              </span>{' '}
              total
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
    </div>
  )
}
