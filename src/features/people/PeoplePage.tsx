import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users,
  Plus,
  Search,
  Check,
  X,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  Receipt,
  Loader2,
  Clock,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react'

import { useAuth } from '@/hooks/useAuth'
import {
  getPeople,
  addPerson,
  updatePerson,
  archivePerson,
  deletePerson,
  settlePersonAllDues,
} from '@/services/people'
import { getAllTransactions } from '@/services/transactions'
import {
  aggregatePeopleDues,
  getNormalizedSplits,
  UNASSIGNED_PERSON_ID,
  type PersonDuesSummary,
} from '@/utils/splitMath'
import { formatINR } from '@/utils/format'
import type { Person, Transaction } from '@/types'
import { DeletePersonModal } from './components/DeletePersonModal'

// ─── Settle Person Confirmation Modal ─────────────────────────────────────────

interface SettleModalProps {
  person: PersonDuesSummary
  transactions: Transaction[]
  onClose: () => void
  onSuccess: (updatedTxns: Transaction[], settledCount: number, totalSettledPaise: number) => void
}

function SettleModal({ person, transactions, onClose, onSuccess }: SettleModalProps) {
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
      setError(err?.message || 'Failed to settle dues')
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
          Mark all open shares for <strong>{person.personName}</strong> as fully settled:
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
            const due = share ? Math.max(0, share.amountPaise - share.repaidPaise) : 0
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

        {error && <p className="mb-3 text-xs font-medium text-[var(--danger)]">{error}</p>}

        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-xl border border-[var(--border)] py-2.5 text-xs font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--success)] py-2.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[var(--success-hover)] disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            <span>Confirm Settlement</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Add/Edit Person Modal ───────────────────────────────────────────────────

interface PersonModalProps {
  person?: Person | null
  onClose: () => void
  onSave: (name: string) => Promise<void>
}

function PersonModal({ person, onClose, onSave }: PersonModalProps) {
  const [name, setName] = useState(person?.name || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Friend name is required')
      return
    }
    setLoading(true)
    setError(null)
    try {
      await onSave(trimmed)
      onClose()
    } catch (err: any) {
      setError(err?.message || 'Failed to save friend')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-xl)]">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-[var(--text-primary)]">
            {person ? 'Edit Friend' : 'Add New Friend'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
              Name
            </label>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Aarav, Meera, Roommates"
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-subtle)] focus:border-[var(--primary)] focus:outline-none"
            />
          </div>

          {error && <p className="text-xs font-medium text-[var(--danger)]">{error}</p>}

          <div className="flex gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 rounded-xl border border-[var(--border)] py-2.5 text-xs font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--primary)] py-2.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50"
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{person ? 'Update' : 'Add Friend'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Combined Person Ledger Item ──────────────────────────────────────────────

export interface MergedPersonItem {
  id: string
  name: string
  isArchived: boolean
  isSynthetic?: boolean
  totalOwedPaise: number
  totalRepaidPaise: number
  pendingDuesPaise: number
  transactionCount: number
  unsettledTxnCount: number
}

// ─── Main People Page ─────────────────────────────────────────────────────────

export function PeoplePage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const [people, setPeople] = useState<Person[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<'dues' | 'all' | 'archived'>('dues')

  const [addModalOpen, setAddModalOpen] = useState(false)
  const [editingPerson, setEditingPerson] = useState<Person | null>(null)
  const [settleTarget, setSettleTarget] = useState<PersonDuesSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MergedPersonItem | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }, [])

  const loadAll = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setLoadError(null)
    try {
      const [peopleList, txnsList] = await Promise.all([
        getPeople(user.uid, true),
        getAllTransactions(user.uid),
      ])
      setPeople(peopleList)
      setTransactions(txnsList)
    } catch (err: unknown) {
      console.error('[Spenza] Error loading people & split ledger:', err)
      setLoadError(
        err instanceof Error
          ? err.message
          : 'Failed to sync split ledger. Please check your network connection.'
      )
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // Derive per-person dues using pure aggregate helper
  const peopleDues = useMemo(() => aggregatePeopleDues(transactions), [transactions])

  // Merge Firestore people documents with transaction dues summaries
  const mergedItems: MergedPersonItem[] = useMemo(() => {
    const duesByPid = new Map<string, PersonDuesSummary>()
    const duesByName = new Map<string, PersonDuesSummary>()

    for (const d of peopleDues) {
      duesByPid.set(d.personId, d)
      duesByName.set(d.personName.toLowerCase().trim(), d)
    }

    const matchedPidKeys = new Set<string>()
    const result: MergedPersonItem[] = []

    for (const p of people) {
      const d = duesByPid.get(p.id) || duesByName.get(p.name.toLowerCase().trim())
      if (d) matchedPidKeys.add(d.personId)

      result.push({
        id: p.id,
        name: p.name,
        isArchived: !!p.isArchived,
        isSynthetic: false,
        totalOwedPaise: d?.totalOwedPaise ?? 0,
        totalRepaidPaise: d?.totalRepaidPaise ?? 0,
        pendingDuesPaise: d?.pendingDuesPaise ?? 0,
        transactionCount: d?.transactionCount ?? 0,
        unsettledTxnCount: d?.unsettledTxnCount ?? 0,
      })
    }

    // Include any participants from splits that don't have a Firestore document yet
    for (const d of peopleDues) {
      if (!matchedPidKeys.has(d.personId)) {
        result.push({
          id: d.personId,
          name: d.personName,
          isArchived: false,
          isSynthetic: true,
          totalOwedPaise: d.totalOwedPaise,
          totalRepaidPaise: d.totalRepaidPaise,
          pendingDuesPaise: d.pendingDuesPaise,
          transactionCount: d.transactionCount,
          unsettledTxnCount: d.unsettledTxnCount,
        })
      }
    }

    return result.sort((a, b) => {
      // 1. Pending dues descending
      if (b.pendingDuesPaise !== a.pendingDuesPaise) {
        return b.pendingDuesPaise - a.pendingDuesPaise
      }
      // 2. Active before archived
      if (a.isArchived !== b.isArchived) {
        return a.isArchived ? 1 : -1
      }
      // 3. Alphabetical
      return a.name.localeCompare(b.name)
    })
  }, [people, peopleDues])

  // Summary Metrics
  const totalPendingDuesPaise = useMemo(
    () => peopleDues.reduce((s, d) => s + d.pendingDuesPaise, 0),
    [peopleDues]
  )
  const friendsWithDuesCount = useMemo(
    () => mergedItems.filter(p => !p.isArchived && p.pendingDuesPaise > 0).length,
    [mergedItems]
  )
  const totalRepaidPaise = useMemo(
    () => peopleDues.reduce((s, d) => s + d.totalRepaidPaise, 0),
    [peopleDues]
  )

  // Filtered list based on active tab and search query
  const filteredList = useMemo(() => {
    let list = mergedItems
    if (activeTab === 'dues') {
      list = list.filter(p => p.pendingDuesPaise > 0)
    } else if (activeTab === 'archived') {
      list = list.filter(p => p.isArchived)
    } else {
      // 'all' includes all non-archived friends, plus any archived who still owe money
      list = list.filter(p => !p.isArchived || p.pendingDuesPaise > 0)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      list = list.filter(p => p.name.toLowerCase().includes(q))
    }

    return list
  }, [mergedItems, activeTab, searchQuery])

  // Handlers
  async function handleAddPerson(name: string) {
    if (!user) return
    const created = await addPerson(user.uid, name)
    setPeople(prev => [...prev, created])
    showToast(`Added ${created.name} to friends ✓`)
  }

  async function handleUpdatePerson(name: string) {
    if (!user || !editingPerson) return
    await updatePerson(user.uid, editingPerson.id, { name })
    setPeople(prev => prev.map(p => (p.id === editingPerson.id ? { ...p, name } : p)))
    showToast(`Updated friend name to ${name} ✓`)
  }

  async function handleToggleArchive(p: MergedPersonItem) {
    if (!user) return
    if (p.isSynthetic) {
      showToast(`Cannot archive unlinked participant`)
      return
    }
    const newArchived = !p.isArchived
    await archivePerson(user.uid, p.id, newArchived)
    setPeople(prev => prev.map(item => (item.id === p.id ? { ...item, isArchived: newArchived } : item)))
    showToast(newArchived ? `Archived ${p.name}` : `Restored ${p.name} ✓`)
  }

  function handleDeletePerson(p: MergedPersonItem) {
    if (p.isSynthetic) {
      showToast('Cannot delete unlinked participant')
      return
    }
    setDeleteTarget(p)
  }

  async function handleConfirmDelete() {
    if (!user || !deleteTarget) return
    const target = deleteTarget
    const res = await deletePerson(user.uid, target.id)
    if (res.deleted) {
      setPeople(prev => prev.filter(item => item.id !== target.id))
      showToast(`Deleted ${target.name} permanently`)
    } else if (res.archived) {
      setPeople(prev => prev.map(item => (item.id === target.id ? { ...item, isArchived: true } : item)))
      showToast(`Archived ${target.name} (has transaction history)`)
    }
  }

  function handleSettleSuccess(
    updatedTxns: Transaction[],
    settledCount: number,
    totalSettledPaise: number
  ) {
    // Optimistic UI updates
    setTransactions(prev => {
      const map = new Map(updatedTxns.map(t => [t.id, t]))
      return prev.map(t => map.get(t.id) || t)
    })
    setSettleTarget(null)
    showToast(`Settled ${settledCount} bill${settledCount !== 1 ? 's' : ''} (${formatINR(totalSettledPaise)}) ✓`)
    // Refetch latest state in background
    loadAll()
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-24 md:pb-12">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--primary-muted)] text-[var(--primary)] shadow-xs">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
                Friends & Split Book
              </h1>
              <p className="text-xs text-[var(--text-muted)]">
                Track shared expenses, dues owed, and settle balances across all transactions
              </p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setAddModalOpen(true)}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[var(--primary-hover)] active:scale-98"
        >
          <Plus className="h-4 w-4" />
          <span>Add Friend</span>
        </button>
      </div>

      {/* Network / Load Error Banner */}
      {loadError && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-2xl border border-[var(--danger)]/30 bg-[var(--danger-muted)] p-4 animate-in fade-in-50 duration-150">
          <div className="flex items-start sm:items-center gap-2.5">
            <AlertTriangle className="mt-0.5 sm:mt-0 h-4 w-4 shrink-0 text-[var(--danger)]" />
            <div>
              <p className="text-xs font-semibold text-[var(--danger)]">Failed to sync split ledger</p>
              <p className="text-xs text-[var(--text-muted)]">{loadError}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={loadAll}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--danger)] px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:opacity-90 transition-opacity active:scale-98"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Top 3 Stat Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Total Pending Dues */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-xs font-medium">Total Pending Dues</span>
            <Clock className="h-4 w-4 text-[var(--warning)]" />
          </div>
          <p className="mt-2 text-2xl font-bold text-[var(--warning)]">
            {formatINR(totalPendingDuesPaise)}
          </p>
          <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
            To be collected back across all shared bills
          </p>
        </div>

        {/* Friends with Open Dues */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-xs font-medium">Friends Owing Money</span>
            <AlertCircle className="h-4 w-4 text-[var(--primary)]" />
          </div>
          <p className="mt-2 text-2xl font-bold text-[var(--text-primary)]">
            {friendsWithDuesCount}
          </p>
          <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
            {friendsWithDuesCount === 0 ? 'All friends are squared up!' : 'With outstanding split balances'}
          </p>
        </div>

        {/* All-time Repaid */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-xs font-medium">Total Repaid Back</span>
            <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
          </div>
          <p className="mt-2 text-2xl font-bold text-[var(--success)]">
            {formatINR(totalRepaidPaise)}
          </p>
          <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
            Settled back from friends all-time
          </p>
        </div>
      </div>

      {/* Filter Tabs & Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Tabs */}
        <div className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1">
          <button
            type="button"
            onClick={() => setActiveTab('dues')}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              activeTab === 'dues'
                ? 'bg-[var(--primary)] text-white shadow-xs'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            Owing Money ({mergedItems.filter(p => p.pendingDuesPaise > 0).length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('all')}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              activeTab === 'all'
                ? 'bg-[var(--primary)] text-white shadow-xs'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            All Friends ({mergedItems.filter(p => !p.isArchived).length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('archived')}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              activeTab === 'archived'
                ? 'bg-[var(--primary)] text-white shadow-xs'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            Archived ({mergedItems.filter(p => p.isArchived).length})
          </button>
        </div>

        {/* Search Input */}
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-subtle)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search friends..."
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-9 pr-8 text-xs text-[var(--text-primary)] placeholder-[var(--text-subtle)] focus:border-[var(--primary)] focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-subtle)] hover:text-[var(--text-primary)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Friends Directory & Ledger Cards */}
      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--primary)]" />
        </div>
      ) : filteredList.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-12 text-center">
          <Users className="h-10 w-10 text-[var(--text-subtle)]" />
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            {activeTab === 'dues'
              ? 'No friends with pending dues!'
              : activeTab === 'archived'
              ? 'No archived friends'
              : 'No friends found'}
          </p>
          <p className="text-xs text-[var(--text-muted)] max-w-sm">
            {activeTab === 'dues'
              ? 'All split bills are completely settled up. When you split bills with friends in transactions, pending dues will appear here automatically.'
              : 'Add friends to easily split bills, track who paid you back, and settle balances in one place.'}
          </p>
          {activeTab === 'all' && (
            <button
              type="button"
              onClick={() => setAddModalOpen(true)}
              className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[var(--primary-hover)]"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add First Friend</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {filteredList.map(person => {
            const hasDues = person.pendingDuesPaise > 0
            const initials = person.name
              .split(' ')
              .map(n => n[0])
              .join('')
              .toUpperCase()
              .slice(0, 2) || '?'

            return (
              <div
                key={person.id}
                className="flex flex-col justify-between rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs transition-all hover:border-[var(--border-strong)]"
              >
                {/* Header: Avatar, Name, Status Badge */}
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-3)] font-bold text-xs text-[var(--text-primary)]">
                        {initials}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="truncate text-sm font-bold text-[var(--text-primary)]">
                            {person.name}
                          </h4>
                          {person.isArchived && (
                            <span className="shrink-0 rounded-md bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-muted)]">
                              Archived
                            </span>
                          )}
                          {person.isSynthetic && (
                            <span className="shrink-0 rounded-md bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-subtle)]">
                              From bill
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[var(--text-subtle)]">
                          {person.transactionCount > 0
                            ? `${person.transactionCount} bill${person.transactionCount !== 1 ? 's' : ''} total`
                            : 'No shared bills yet'}
                        </p>
                      </div>
                    </div>

                    {/* Dues Status Badge */}
                    <div className="shrink-0">
                      {hasDues ? (
                        <div className="inline-flex items-center gap-1 rounded-full bg-[var(--warning-muted)] px-2.5 py-1 text-xs font-bold text-[var(--warning)]">
                          <span>Owes</span>
                          <span>{formatINR(person.pendingDuesPaise)}</span>
                        </div>
                      ) : person.totalOwedPaise > 0 ? (
                        <div className="inline-flex items-center gap-1 rounded-full bg-[var(--success-muted)] px-2.5 py-1 text-xs font-semibold text-[var(--success)]">
                          <Check className="h-3 w-3" />
                          <span>All Settled</span>
                        </div>
                      ) : (
                        <div className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-subtle)]">
                          No Dues
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Bill Details Breakdown */}
                  {person.totalOwedPaise > 0 && (
                    <div className="mt-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-[11px] text-[var(--text-secondary)]">
                      <div className="flex items-center justify-between">
                        <span>Total fronted for {person.name}:</span>
                        <span className="font-semibold text-[var(--text-primary)]">
                          {formatINR(person.totalOwedPaise)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between">
                        <span>Repaid back:</span>
                        <span className="font-semibold text-[var(--success)]">
                          {formatINR(person.totalRepaidPaise)}
                        </span>
                      </div>
                      {hasDues && (
                        <div className="mt-1 flex items-center justify-between border-t border-[var(--border)] pt-1 font-bold">
                          <span>Outstanding balance:</span>
                          <span className="text-[var(--warning)]">
                            {formatINR(person.pendingDuesPaise)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Footer Action Buttons */}
                <div className="mt-4 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
                  <div className="flex items-center gap-1">
                    {!person.isSynthetic && (
                      <>
                        <button
                          type="button"
                          onClick={() => setEditingPerson(people.find(p => p.id === person.id) || null)}
                          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--primary)]"
                          title="Rename Friend"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleArchive(person)}
                          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--warning)]"
                          title={person.isArchived ? 'Unarchive' : 'Archive'}
                        >
                          {person.isArchived ? (
                            <ArchiveRestore className="h-3.5 w-3.5" />
                          ) : (
                            <Archive className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePerson(person)}
                          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--danger)]"
                          title="Delete Friend"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {person.transactionCount > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          navigate(
                            `/app/transactions?filter=pending_dues&person=${encodeURIComponent(
                              person.name
                            )}`
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-semibold text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                      >
                        <Receipt className="h-3 w-3" />
                        <span>View Bills</span>
                      </button>
                    )}

                    {hasDues && (
                      <button
                        type="button"
                        onClick={() => {
                          const target = peopleDues.find(
                            d =>
                              d.personId === person.id ||
                              d.personName.toLowerCase() === person.name.toLowerCase()
                          )
                          if (target) {
                            setSettleTarget(target)
                          } else {
                            // Synthesize target if not in peopleDues array directly
                            setSettleTarget({
                              personId: person.id,
                              personName: person.name,
                              totalOwedPaise: person.totalOwedPaise,
                              totalRepaidPaise: person.totalRepaidPaise,
                              pendingDuesPaise: person.pendingDuesPaise,
                              transactionCount: person.transactionCount,
                              unsettledTxnCount: person.unsettledTxnCount,
                            })
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-lg bg-[var(--success)] px-2.5 py-1 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[var(--success-hover)]"
                      >
                        <Check className="h-3 w-3" />
                        <span>Settle All</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Settle Modal */}
      {settleTarget && (
        <SettleModal
          person={settleTarget}
          transactions={transactions}
          onClose={() => setSettleTarget(null)}
          onSuccess={handleSettleSuccess}
        />
      )}

      {/* Add Person Modal */}
      {addModalOpen && (
        <PersonModal
          onClose={() => setAddModalOpen(false)}
          onSave={handleAddPerson}
        />
      )}

      {/* Edit Person Modal */}
      {editingPerson && (
        <PersonModal
          person={editingPerson}
          onClose={() => setEditingPerson(null)}
          onSave={handleUpdatePerson}
        />
      )}

      {/* Delete Person Modal */}
      {deleteTarget && (
        <DeletePersonModal
          person={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleConfirmDelete}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed top-5 left-1/2 z-50 -translate-x-1/2 flex items-center gap-2 rounded-xl border border-[var(--success)] bg-[var(--success-muted)] px-4 py-2.5 text-sm font-medium text-[var(--success)] shadow-[var(--shadow-lg)]">
          <Check className="h-4 w-4 shrink-0" />
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}
