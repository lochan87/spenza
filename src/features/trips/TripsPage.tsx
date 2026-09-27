import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { Plus, Map as MapIcon, Archive, Pencil } from 'lucide-react'
import { Timestamp } from 'firebase/firestore'
import { useAuth } from '@/hooks/useAuth'
import { getTrips, getAllTripTransactions } from '@/services/trips'
import { formatINR, formatINRCompact } from '@/utils/format'
import { TRIP_ACCENT_COLOR } from '@/utils/tripBuckets'
import { Drawer } from '@/components/layout/Drawer'
import { NewTripForm } from './NewTripForm'
import { SkeletonCard } from '@/features/dashboard/components/SkeletonCard'
import type { Trip, Transaction } from '@/types'

interface TripWithStats extends Trip {
  totalPaise: number
  days: number
  avgPerDay: number
}

export function TripsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [trips, setTrips] = useState<TripWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editTrip, setEditTrip] = useState<Trip | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const loadTrips = useCallback(async () => {
    if (!user) return
    setLoading(true)
    try {
      const [rawTrips, allTxns] = await Promise.all([
        getTrips(user.uid),
        getAllTripTransactions(user.uid),
      ])

      // Group txn totals by tripId
      const totalsMap = new Map<string, number>()
      for (const tx of allTxns as Transaction[]) {
        if (tx.tripId) {
          totalsMap.set(tx.tripId, (totalsMap.get(tx.tripId) ?? 0) + tx.amountPaise)
        }
      }

      const withStats: TripWithStats[] = rawTrips.map(trip => {
        const totalPaise = totalsMap.get(trip.id) ?? 0
        const start = (trip.startDate as Timestamp).toDate()
        const end = trip.endDate ? (trip.endDate as Timestamp).toDate() : new Date()
        const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1)
        return { ...trip, totalPaise, days, avgPerDay: totalPaise / days }
      })

      setTrips(withStats)
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => { loadTrips() }, [loadTrips])

  const visible = trips.filter(t => showArchived ? t.isArchived : !t.isArchived)

  return (
    <div className="flex flex-col gap-5 pb-20 md:pb-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Trips</h1>
          <p className="text-sm text-[var(--text-muted)]">{visible.length} trip{visible.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowArchived(a => !a)}
            className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
          >
            <Archive className="h-3.5 w-3.5" />
            {showArchived ? 'Active' : 'Archived'}
          </button>
          <button
            onClick={() => { setEditTrip(null); setDrawerOpen(true) }}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: TRIP_ACCENT_COLOR }}
          >
            <Plus className="h-4 w-4" />
            New Trip
          </button>
        </div>
      </div>

      {/* Trips grid */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[0, 1, 2].map(i => <SkeletonCard key={i} height="h-40" />)}
        </div>
      ) : visible.length === 0 ? (
        <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]">
          <MapIcon className="h-10 w-10 text-[var(--text-subtle)]" />
          <p className="text-sm text-[var(--text-muted)]">No trips yet — plan your first adventure!</p>
          <button
            onClick={() => { setEditTrip(null); setDrawerOpen(true) }}
            className="rounded-xl px-4 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: TRIP_ACCENT_COLOR }}
          >
            + New Trip
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {visible.map(trip => {
            const start = (trip.startDate as Timestamp).toDate()
            const end = trip.endDate ? (trip.endDate as Timestamp).toDate() : null
            const dateStr = end
              ? `${format(start, 'd MMM')} – ${format(end, 'd MMM yyyy')}`
              : `From ${format(start, 'd MMM yyyy')}`

            const budgetPct = trip.budgetPaise
              ? Math.min(150, (trip.totalPaise / trip.budgetPaise) * 100)
              : null

            return (
              <div
                key={trip.id}
                className="group relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)] transition-all hover:shadow-[var(--shadow-md)] cursor-pointer"
                onClick={() => navigate(`/app/trips/${trip.id}`)}
              >
                {/* Color accent bar */}
                <div className="h-1.5 w-full" style={{ backgroundColor: trip.coverColor }} />

                <div className="p-5">
                  <div className="mb-3 flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="flex h-11 w-11 items-center justify-center rounded-xl text-2xl"
                        style={{ backgroundColor: trip.coverColor + '22' }}
                      >
                        {trip.coverEmoji}
                      </div>
                      <div>
                        <h3 className="font-semibold text-[var(--text-primary)]">{trip.name}</h3>
                        <p className="text-xs text-[var(--text-muted)]">{dateStr}</p>
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); setEditTrip(trip); setDrawerOpen(true) }}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--surface-2)]"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-[10px] text-[var(--text-subtle)]">Total Spent</p>
                      <p className="text-base font-bold text-[var(--text-primary)]">
                        {formatINRCompact(trip.totalPaise)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--text-subtle)]">Days</p>
                      <p className="text-base font-bold text-[var(--text-primary)]">{trip.days}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--text-subtle)]">Avg/Day</p>
                      <p className="text-base font-bold text-[var(--text-primary)]">
                        {formatINRCompact(trip.avgPerDay)}
                      </p>
                    </div>
                  </div>

                  {/* Budget bar if set */}
                  {budgetPct !== null && (
                    <div className="mt-3">
                      <div className="mb-1 flex justify-between text-[10px] text-[var(--text-subtle)]">
                        <span>Budget</span>
                        <span>{formatINR(trip.totalPaise)} / {formatINR(trip.budgetPaise!)}</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-[var(--surface-2)]">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, budgetPct)}%`,
                            backgroundColor: budgetPct >= 100 ? 'var(--danger)' : budgetPct >= 90 ? '#F97316' : budgetPct >= 70 ? 'var(--warning)' : 'var(--success)',
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* New/Edit trip drawer */}
      <Drawer open={drawerOpen} onClose={() => { setDrawerOpen(false); setEditTrip(null) }}>
        <NewTripForm
          editTrip={editTrip}
          onClose={() => { setDrawerOpen(false); setEditTrip(null) }}
          onSuccess={() => { setDrawerOpen(false); setEditTrip(null); loadTrips() }}
        />
      </Drawer>
    </div>
  )
}
