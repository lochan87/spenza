import {
  collection, doc, setDoc, getDoc, getDocs, getDocsFromServer, deleteDoc,
  query, orderBy, where, serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/firebase/config'
import type { Trip } from '@/types'

function notifyFinancialChange(type: string, uid: string, entityId?: string) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent('spenza_financial_mutation', {
          detail: { type, uid, entityId, timestamp: Date.now() },
        })
      )
    } catch {
      // Ignore
    }
  }
}

const tripsColl = (uid: string) => collection(db, 'users', uid, 'trips')
const tripRef   = (uid: string, id: string) => doc(db, 'users', uid, 'trips', id)

export async function getTrips(uid: string): Promise<Trip[]> {
  const snap = await getDocs(query(tripsColl(uid), orderBy('startDate', 'desc')))
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Trip)
}

export async function getTrip(uid: string, id: string): Promise<Trip | null> {
  const snap = await getDoc(tripRef(uid, id))
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Trip) : null
}

export async function addTrip(
  uid: string,
  data: Omit<Trip, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const ref = doc(tripsColl(uid))
  await setDoc(ref, {
    ...data,
    id: ref.id,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  notifyFinancialChange('trip_changed', uid, ref.id)
  return ref.id
}

export async function updateTrip(
  uid: string,
  id: string,
  data: Partial<Omit<Trip, 'id' | 'createdAt'>>
): Promise<void> {
  await setDoc(tripRef(uid, id), { ...data, updatedAt: serverTimestamp() }, { merge: true })
  notifyFinancialChange('trip_changed', uid, id)
}

export async function archiveTrip(
  uid: string,
  id: string,
  isArchived = true
): Promise<void> {
  const cleanUid = uid.trim()
  const cleanId = id.trim()
  await updateTrip(cleanUid, cleanId, { isArchived })
}

/**
 * Delete a trip if no transactions reference it.
 * Reference check uses authoritative server data to prevent deleting trips with un-synced transactions.
 * If transactions exist, safely archive the trip instead to preserve financial history.
 *
 * Concurrency note:
 * Client-side reference checks are not atomic with deleteDoc; a concurrent transaction creation
 * after getDocsFromServer could produce a dangling reference. Where absolute safety against races
 * is required, records are preserved via archiveTrip rather than hard deletion.
 */
export async function deleteTrip(
  uid: string,
  id: string
): Promise<{ deleted: boolean; archived: boolean }> {
  const cleanUid = uid.trim()
  const cleanId = id.trim()

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Cannot delete trip while offline')
  }

  // Use authoritative server data to verify references
  const snap = await getDocsFromServer(
    query(
      collection(db, 'users', cleanUid, 'transactions'),
      where('tripId', '==', cleanId)
    )
  )
  if (!snap.empty) {
    await archiveTrip(cleanUid, cleanId, true)
    return { deleted: false, archived: true }
  }

  await deleteDoc(tripRef(cleanUid, cleanId))
  notifyFinancialChange('trip_changed', cleanUid, cleanId)
  return { deleted: true, archived: false }
}

/** Get all transactions that belong to this trip */
export async function getTripTransactions(uid: string, tripId: string) {
  const snap = await getDocs(
    query(
      collection(db, 'users', uid, 'transactions'),
      where('tripId', '==', tripId)
    )
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as any)
}

/** Get all trip-tagged transactions (for trips list totals) */
export async function getAllTripTransactions(uid: string) {
  const snap = await getDocs(
    query(
      collection(db, 'users', uid, 'transactions'),
      where('tripId', '!=', null)
    )
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as any)
}
