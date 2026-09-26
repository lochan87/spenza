import {
  collection, doc, setDoc, getDoc, getDocs, deleteDoc,
  query, orderBy, where, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { db } from '@/firebase/config'
import type { Trip } from '@/types'

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
  return ref.id
}

export async function updateTrip(
  uid: string,
  id: string,
  data: Partial<Omit<Trip, 'id' | 'createdAt'>>
): Promise<void> {
  await setDoc(tripRef(uid, id), { ...data, updatedAt: serverTimestamp() }, { merge: true })
}

export async function deleteTrip(uid: string, id: string): Promise<void> {
  await deleteDoc(tripRef(uid, id))
}

/** Get all transactions that belong to this trip */
export async function getTripTransactions(uid: string, tripId: string) {
  const { getDocs: gd, query: q, collection: c, where: w } = await import('firebase/firestore')
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
