import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts'
import { ArrowLeft, Pencil, Calendar, Users, CheckCircle2, Archive, ArchiveRestore } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { getTrip, getTripTransactions, archiveTrip } from '@/services/trips'
import { getCategories, getPaymentAccounts } from '@/services/transactions'
import { formatINR, formatINRCompact, parseTransactionDate } from '@/utils/format'
import { getCategoryMeta } from '@/utils/categoryColors'
import { getPaymentMeta, getAccountTypeMeta } from '@/utils/paymentColors'
import {
  TRIP_BUCKET_META, getBudgetColor,
  type TripBucket,
  calculateTripAccountingSummary,
  calculateTripDayTotals,
} from '@/utils/tripBuckets'
import { getNetSpendPaise, getRecoverablePaise, toNonNegativeIntPaise } from '@/utils/splitMath'
import { Drawer } from '@/components/layout/Drawer'
import { NewTripForm } from './NewTripForm'
import { SkeletonCard } from '@/features/dashboard/components/SkeletonCard'
import type { Trip, Transaction, Category, PaymentAccount } from '@/types'

export function TripDetailPage() {
  const { tripId } = useParams<{ tripId: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [txns, setTxns] = useState<Transaction[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [accounts, setAccounts] = useState<PaymentAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [editOpen, setEditOpen] = useState(false)

  const load = useCallback(async () => {
    if (!user || !tripId) return
    setLoading(true)
    try {
      const [t, txnList, cats, accs] = await Promise.all([
        getTrip(user.uid, tripId),
        getTripTransactions(user.uid, tripId),
        getCategories(user.uid),
        getPaymentAccounts(user.uid),
      ])
      setTrip(t)
      setTxns(txnList)
      setCategories(cats)
      setAccounts(accs)
    } finally {
      setLoading(false)
    }
  }, [user, tripId])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div className="flex flex-col gap-4 pb-20">
        <SkeletonCard height="h-32" />
        <SkeletonCard height="h-40" />
        <SkeletonCard height="h-52" />
      </div>
    )
  }

  if (!trip) {
    return (
      <div className="flex h-52 items-center justify-center text-sm text-[var(--text-muted)]">
        Trip not found.
      </div>
    )
  }

  const startDate = parseTransactionDate(trip.startDate) ?? new Date()
  const endDate = (trip.endDate ? parseTransactionDate(trip.endDate) : null) ?? new Date()

  // ── Trip Accounting Summary ─────────────────────────────────────────────────
  const summary = calculateTripAccountingSummary(trip, txns, categories)
  const {
    totalNetSpendPaise,
    totalGrossOutflowPaise,
    recoverablePaise,
    repaidPaise,
    pendingPaise,
    days,
    avgPerDayPaise,
    budgetPct,
    bucketTotals,
  } = summary

  const catMap = new Map(categories.map(c => [c.id, c]))

  // ── Bucket breakdown ─────────────────────────────────────────────────────────
  const bucketRows = (Object.keys(TRIP_BUCKET_META) as TripBucket[])
    .filter(b => (bucketTotals.get(b) ?? 0) > 0)
    .sort((a, b) => (bucketTotals.get(b) ?? 0) - (bucketTotals.get(a) ?? 0))

  // ── Per-day totals ────────────────────────────────────────────────────────────
  const uniqueTxnDays = new Set(
    txns.map(tx => {
      const d = parseTransactionDate(tx.date)
      return d ? format(d, 'yyyy-MM-dd') : null
    }).filter((d): d is string => d !== null)
  ).size
  const dayTotals = calculateTripDayTotals(txns, startDate, endDate)

  // ── Payment mode breakdown (Gross Outflow) ──────────────────────────────────
  const modeMap = new Map<string, number>()
  const accMap = new Map<string, number>()
  const ACCOUNT_MODES = new Set(['UPI', 'Bank Transfer', 'Card'])
  for (const tx of txns) {
    const gross = toNonNegativeIntPaise(tx.amountPaise)
    modeMap.set(tx.paymentMode, (modeMap.get(tx.paymentMode) ?? 0) + gross)
    if (ACCOUNT_MODES.has(tx.paymentMode) && tx.paymentAccountId) {
      accMap.set(tx.paymentAccountId, (accMap.get(tx.paymentAccountId) ?? 0) + gross)
    }
  }

  return (
    <div className="flex flex-col gap-5 pb-20 md:pb-6">
      {/* Back nav */}
      <button
        onClick={() => navigate('/app/trips')}
        className="flex items-center gap-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="h-4 w-4" /> All Trips
      </button>

      {/* Header card */}
      <div
        className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-sm)]"
      >
        {/* Color stripe */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.08]"
          style={{ background: `linear-gradient(135deg, ${trip.coverColor}, transparent)` }}
          aria-hidden
        />
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div
              className="flex h-14 w-14 items-center justify-center rounded-2xl text-3xl"
              style={{ backgroundColor: trip.coverColor + '22' }}
            >
              {trip.coverEmoji}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-[var(--text-primary)]">{trip.name}</h1>
                {trip.isArchived && (
                  <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-muted)] border border-[var(--border)]">
                    Archived
                  </span>
                )}
              </div>
              <p className="flex items-center gap-1 text-sm text-[var(--text-muted)]">
                <Calendar className="h-3.5 w-3.5" />
                {format(startDate, 'd MMM')} – {format(endDate, 'd MMM yyyy')} · {days} days
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={async () => {
                if (!user || !trip) return
                const nextArchived = !trip.isArchived
                await archiveTrip(user.uid, trip.id, nextArchived)
                setTrip({ ...trip, isArchived: nextArchived })
              }}
              title={trip.isArchived ? 'Restore trip' : 'Archive trip'}
              aria-label={trip.isArchived ? 'Restore trip' : 'Archive trip'}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors"
            >
              {trip.isArchived ? (
                <ArchiveRestore className="h-3.5 w-3.5 text-[var(--text-muted)]" />
              ) : (
                <Archive className="h-3.5 w-3.5 text-[var(--text-muted)]" />
              )}
            </button>
            <button
              onClick={() => setEditOpen(true)}
              title="Edit trip"
              aria-label="Edit trip"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors"
            >
              <Pencil className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2.5">
            <p className="text-[10px] text-[var(--text-subtle)]">My Net Spend</p>
            <p className="text-base font-bold text-[var(--text-primary)]">{formatINR(totalNetSpendPaise)}</p>
            {totalGrossOutflowPaise > totalNetSpendPaise && (
              <p className="text-[9px] text-[var(--text-subtle)] mt-0.5">
                Gross {formatINR(totalGrossOutflowPaise)}
              </p>
            )}
          </div>
          <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2.5">
            <p className="text-[10px] text-[var(--text-subtle)]">Days</p>
            <p className="text-base font-bold text-[var(--text-primary)]">{days}</p>
          </div>
          <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2.5">
            <p className="text-[10px] text-[var(--text-subtle)]">Avg/Day</p>
            <p className="text-base font-bold text-[var(--text-primary)]">{formatINRCompact(avgPerDayPaise)}</p>
          </div>
        </div>

        {/* Budget bar */}
        {budgetPct !== null && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-[var(--text-muted)]">
              <span>Trip Budget</span>
              <span>
                {formatINR(totalNetSpendPaise)} / {formatINR(trip.budgetPaise!)}
                <span className="ml-1 font-semibold" style={{ color: getBudgetColor(budgetPct) }}>
                  ({budgetPct.toFixed(0)}%)
                </span>
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-[var(--surface-2)]">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, budgetPct)}%`,
                  backgroundColor: getBudgetColor(budgetPct),
                }}
              />
            </div>
            {budgetPct >= 90 && (
              <p className="mt-1 text-xs font-medium" style={{ color: getBudgetColor(budgetPct) }}>
                {budgetPct >= 100 ? '⚠ Over budget!' : '⚠ Approaching budget limit'}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Trip-Level Recoverables & Dues */}
      {recoverablePaise > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                className="flex h-7 w-7 items-center justify-center rounded-lg"
                style={{
                  backgroundColor: pendingPaise > 0 ? 'var(--warning-muted)' : 'var(--success-muted)',
                  color: pendingPaise > 0 ? 'var(--warning)' : 'var(--success)',
                }}
              >
                <Users className="h-3.5 w-3.5" />
              </div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Trip Splits & Pending Dues
              </h3>
            </div>
            {pendingPaise > 0 ? (
              <span className="rounded-full bg-[var(--warning-muted)] px-2.5 py-0.5 text-[10px] font-semibold text-[var(--warning)]">
                {formatINRCompact(pendingPaise)} pending
              </span>
            ) : (
              <span className="flex items-center gap-1 rounded-full bg-[var(--success-muted)] px-2.5 py-0.5 text-[10px] font-semibold text-[var(--success)]">
                <CheckCircle2 className="h-3 w-3" /> All settled
              </span>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-[var(--surface-2)] p-2.5">
              <p className="text-[10px] text-[var(--text-subtle)]">Owed to You</p>
              <p
                className="text-sm font-extrabold"
                style={{ color: pendingPaise > 0 ? 'var(--warning)' : 'var(--success)' }}
              >
                {formatINR(pendingPaise)}
              </p>
            </div>
            <div className="rounded-xl bg-[var(--surface-2)] p-2.5">
              <p className="text-[10px] text-[var(--text-subtle)]">Fronted for Group</p>
              <p className="text-sm font-bold text-[var(--text-primary)]">
                {formatINR(recoverablePaise)}
              </p>
            </div>
            <div className="rounded-xl bg-[var(--surface-2)] p-2.5">
              <p className="text-[10px] text-[var(--text-subtle)]">Repaid Back</p>
              <p className="text-sm font-bold text-[var(--text-primary)]">
                {formatINR(repaidPaise)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Sub-category bucket breakdown */}
      {bucketRows.length > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <h3 className="mb-4 text-sm font-semibold text-[var(--text-primary)]">Spending by Category</h3>
          <div className="flex flex-col gap-3">
            {bucketRows.map(bucket => {
              const bTotal = bucketTotals.get(bucket) ?? 0
              const meta = TRIP_BUCKET_META[bucket]
              const pct = totalNetSpendPaise > 0 ? (bTotal / totalNetSpendPaise) * 100 : 0
              return (
                <div key={bucket}>
                  <div className="mb-1 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg text-base"
                        style={{ backgroundColor: meta.bg }}>
                        {meta.emoji}
                      </span>
                      <span className="text-sm font-medium text-[var(--text-primary)]">{bucket}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-[var(--text-subtle)]">{pct.toFixed(0)}%</span>
                      <span className="text-sm font-semibold text-[var(--text-primary)]">
                        {formatINRCompact(bTotal)}
                      </span>
                    </div>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-[var(--surface-2)]">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: meta.color }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Per-day spending bar chart (hidden when a multi-day trip has all transactions on a single default date) */}
      {dayTotals.length > 0 && dayTotals.length <= 30 && (days === 1 || uniqueTxnDays >= 2) && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <h3 className="mb-4 text-sm font-semibold text-[var(--text-primary)]">Day-by-Day Spending</h3>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={dayTotals} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false}
                stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => formatINRCompact(v)}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                axisLine={false} tickLine={false} width={48} />
              <Tooltip
                formatter={(v) => [formatINR(Number(v ?? 0)), 'Net Spent']}
                contentStyle={{
                  backgroundColor: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  fontSize: 12,
                }}
              />
              <Bar dataKey="totalPaise" fill={trip.coverColor} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Payment mode breakdown */}
      {modeMap.size > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">How This Trip Was Funded</h3>
          <div className="flex flex-col gap-2">
            {[...modeMap.entries()].sort((a, b) => b[1] - a[1]).map(([mode, paise]) => {
              const meta = getPaymentMeta(mode)
              const pct = totalGrossOutflowPaise > 0 ? (paise / totalGrossOutflowPaise) * 100 : 0
              return (
                <div key={mode} className="flex items-center gap-3">
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                    style={{ backgroundColor: meta.bgColor, color: meta.color }}>
                    {mode}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-2)]">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: meta.color }} />
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-[var(--text-primary)]">
                    {formatINRCompact(paise)}
                  </span>
                </div>
              )
            })}
          </div>
          {/* Specific accounts */}
          {accMap.size > 0 && (
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              <p className="mb-2 text-xs text-[var(--text-subtle)] font-medium uppercase tracking-wide">
                By Account
              </p>
              <div className="flex flex-col gap-1.5">
                {[...accMap.entries()].sort((a, b) => b[1] - a[1]).map(([accId, paise]) => {
                  const acc = accounts.find(a => a.id === accId)
                  const meta = getAccountTypeMeta(acc?.type ?? 'Bank')
                  return (
                    <div key={accId} className="flex items-center gap-2">
                      <div className="flex h-5 w-5 items-center justify-center rounded-md text-[9px] font-bold"
                        style={{ backgroundColor: meta.bgColor, color: meta.color }}>
                        {(acc?.type ?? 'B').slice(0, 1)}
                      </div>
                      <span className="flex-1 text-sm text-[var(--text-primary)]">
                        {acc?.name ?? 'Unknown'}
                      </span>
                      <span className="text-sm font-semibold text-[var(--text-primary)]">
                        {formatINRCompact(paise)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Full transaction list */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
        <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
          All Transactions ({txns.length})
        </h3>
        {txns.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No transactions yet. Add some!</p>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--border)]">
            {[...txns].sort((a, b) =>
              (b.date as Timestamp).seconds - (a.date as Timestamp).seconds
            ).map(tx => {
              const cat = catMap.get(tx.categoryId)
              const catMeta = getCategoryMeta(cat?.name ?? 'Other')
              const payMeta = getPaymentMeta(tx.paymentMode)
              const netPaise = getNetSpendPaise(tx)
              const recPaise = getRecoverablePaise(tx)

              return (
                <div key={tx.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg text-base"
                    style={{ backgroundColor: catMeta.color + '20' }}>
                    {catMeta.emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {tx.description}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-[var(--text-subtle)]">
                        {(() => {
                          const d = parseTransactionDate(tx.date)
                          return d ? format(d, 'd MMM') : 'Undated'
                        })()}
                      </span>
                      <span className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                        style={{ backgroundColor: payMeta.bgColor, color: payMeta.color }}>
                        {tx.paymentMode}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end shrink-0">
                    <span className="text-sm font-bold text-[var(--text-primary)]">
                      {formatINR(netPaise)}
                    </span>
                    {recPaise > 0 && (
                      <span className="text-[10px] text-[var(--text-subtle)]">
                        Gross {formatINR(tx.amountPaise)}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Edit trip drawer */}
      <Drawer open={editOpen} onClose={() => setEditOpen(false)}>
        <NewTripForm
          editTrip={trip}
          onClose={() => setEditOpen(false)}
          onSuccess={() => { setEditOpen(false); load() }}
        />
      </Drawer>
    </div>
  )
}
