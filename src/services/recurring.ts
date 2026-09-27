import {
  collection, doc, setDoc, getDocs, deleteDoc,
  query, orderBy, where, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { addDays, addMonths, addWeeks, addYears } from 'date-fns'
import { db } from '@/firebase/config'
import type { RecurringItem, RecurringFrequency } from '@/types'

const recColl = (uid: string) => collection(db, 'users', uid, 'recurring')
const recRef  = (uid: string, id: string) => doc(db, 'users', uid, 'recurring', id)

export async function getRecurringItems(uid: string): Promise<RecurringItem[]> {
  const snap = await getDocs(query(recColl(uid), orderBy('createdAt', 'desc')))
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as RecurringItem)
}

export async function getOverdueRecurring(uid: string): Promise<RecurringItem[]> {
  const now = Timestamp.fromDate(new Date())
  const snap = await getDocs(
    query(recColl(uid), where('isActive', '==', true), where('nextDueDate', '<=', now))
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as RecurringItem)
}

export async function getUpcomingRecurring(uid: string, days = 7): Promise<RecurringItem[]> {
  const now = new Date()
  const until = addDays(now, days)
  const snap = await getDocs(
    query(
      recColl(uid),
      where('isActive', '==', true),
      where('nextDueDate', '<=', Timestamp.fromDate(until))
    )
  )
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }) as RecurringItem)
    .filter(r => r.nextDueDate.toDate() >= now)  // exclude already-overdue (handled separately)
}

export async function addRecurringItem(
  uid: string,
  data: Omit<RecurringItem, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const ref = doc(recColl(uid))
  await setDoc(ref, {
    ...data,
    id: ref.id,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function updateRecurringItem(
  uid: string,
  id: string,
  data: Partial<Omit<RecurringItem, 'id' | 'createdAt'>>
): Promise<void> {
  await setDoc(recRef(uid, id), { ...data, updatedAt: serverTimestamp() }, { merge: true })
}

export async function deleteRecurringItem(uid: string, id: string): Promise<void> {
  await deleteDoc(recRef(uid, id))
}

/**
 * Advance nextDueDate to the next cycle after the given date.
 * Called after the user confirms logging a recurring expense.
 */
export function computeNextDueDate(
  current: Date,
  frequency: RecurringFrequency,
  dayOfMonth: number | null,
  _dayOfWeek: number | null
): Date {
  switch (frequency) {
    case 'weekly': {
      return addWeeks(current, 1)
    }
    case 'monthly': {
      const next = addMonths(current, 1)
      // Snap to the same day of month if specified
      if (dayOfMonth) {
        next.setDate(Math.min(dayOfMonth, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()))
      }
      return next
    }
    case 'yearly': {
      return addYears(current, 1)
    }
  }
}

/** Format recurring frequency for display */
export function formatFrequency(item: RecurringItem): string {
  const { frequency, dayOfMonth, dayOfWeek } = item
  if (frequency === 'monthly' && dayOfMonth) return `Monthly on ${ordinal(dayOfMonth)}`
  if (frequency === 'weekly' && dayOfWeek != null) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    return `Weekly on ${days[dayOfWeek]}`
  }
  if (frequency === 'yearly') return 'Yearly'
  return frequency.charAt(0).toUpperCase() + frequency.slice(1)
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}
