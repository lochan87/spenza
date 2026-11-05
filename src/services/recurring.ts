import {
  collection, doc, setDoc, getDocs, deleteDoc,
  query, orderBy, where, serverTimestamp, Timestamp, runTransaction,
} from 'firebase/firestore'
import { addDays, addMonths, addWeeks, addYears } from 'date-fns'
import { db } from '@/firebase/config'
import type { RecurringItem, RecurringFrequency } from '@/types'
import { TransactionSchema } from '@/utils/schemas'

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
  data: Partial<Omit<RecurringItem, 'id' | 'createdAt'>>,
  original?: RecurringItem
): Promise<void> {
  const ref = recRef(uid, id)
  const touchesSchedule = data.nextDueDate !== undefined || data.frequency !== undefined ||
    data.dayOfMonth !== undefined || data.dayOfWeek !== undefined || data.monthDay !== undefined
  if (!touchesSchedule) {
    // Non-schedule edits (e.g. pausing) stay queued offline like other ordinary writes.
    const { lastGeneratedDate: _ignoredGeneration, ...editable } = data
    await setDoc(ref, { ...editable, updatedAt: serverTimestamp() }, { merge: true })
    return
  }
  await runTransaction(db, async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists()) throw new RecurringConfirmationError('This recurring expense no longer exists. Refresh the page.')
    const latest = snap.data() as RecurringItem
    if (!original || !sameSchedule(latest, original)) {
      throw new RecurringConfirmationError('The recurring schedule changed or was logged in another tab. Reload the Recurring page and reopen this form before saving.')
    }
    // Confirmation owns lastGeneratedDate; a stale editor must never restore it.
    const { lastGeneratedDate: _lastGeneratedDate, ...editable } = data
    txn.update(ref, { ...editable, updatedAt: serverTimestamp() })
  })
}

export class RecurringConfirmationError extends Error {}

const nullable = <T>(value: T | null | undefined): T | null => value ?? null

function sameSchedule(a: RecurringItem, b: RecurringItem): boolean {
  return sameTimestamp(a.nextDueDate, b.nextDueDate) && a.frequency === b.frequency &&
    nullable(a.dayOfMonth) === nullable(b.dayOfMonth) &&
    nullable(a.dayOfWeek) === nullable(b.dayOfWeek) &&
    nullable(a.monthDay) === nullable(b.monthDay)
}

function sameTimestamp(a: Timestamp | null | undefined, b: Timestamp | null | undefined): boolean {
  if (!a || !b) return false
  if (typeof a.isEqual === 'function') return a.isEqual(b)
  return a.seconds === b.seconds && a.nanoseconds === b.nanoseconds
}

/**
 * One item and one exact due instant identify an occurrence, even if the item's
 * frequency is edited later. `|` cannot appear in an encodeURIComponent result,
 * so different item IDs cannot collide with the timestamp segments.
 */
export function recurringOccurrenceId(item: Pick<RecurringItem, 'id' | 'nextDueDate'>): string {
  const { seconds, nanoseconds } = item.nextDueDate ?? {}
  if (!item.id || !Number.isSafeInteger(seconds) || !Number.isSafeInteger(nanoseconds) ||
      nanoseconds < 0 || nanoseconds >= 1_000_000_000) {
    throw new RecurringConfirmationError('Invalid recurring expense identifier.')
  }
  const id = `recurring|${encodeURIComponent(item.id)}|${seconds}|${nanoseconds}`
  if (id.length > 1400) throw new RecurringConfirmationError('Invalid recurring expense identifier.')
  return id
}

export async function confirmRecurringOccurrence(uid: string, item: RecurringItem, amountPaise: number): Promise<{
  created: boolean; transactionId: string; recurringItem: RecurringItem | null
}> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new RecurringConfirmationError('You are offline. Reconnect and retry this occurrence; it is safe to retry.')
  }
  const transactionId = recurringOccurrenceId(item)
  const expenseRef = doc(db, 'users', uid, 'transactions', transactionId)
  const scheduleRef = recRef(uid, item.id)
  const now = Timestamp.now()
  return runTransaction(db, async txn => {
    // Read both documents before any writes. On contention the SDK reruns this callback.
    const scheduleSnap = await txn.get(scheduleRef)
    const expenseSnap = await txn.get(expenseRef)
    const latest = scheduleSnap.exists() ? { ...scheduleSnap.data(), id: item.id } as RecurringItem : null
    // Expenses created by the pre-Phase-3 workflow have random ids and no
    // recurringItemId, so they cannot be matched to an occurrence with certainty.
    if (expenseSnap.exists()) {
      const expense = expenseSnap.data()
      if (expense.recurringItemId !== item.id || !sameTimestamp(item.nextDueDate, expense.recurringOccurrenceDate)) {
        throw new RecurringConfirmationError('An existing expense conflicts with this occurrence. Nothing was overwritten; please review your transactions.')
      }
      if (latest && latest.nextDueDate.toMillis() <= item.nextDueDate.toMillis()) {
        throw new RecurringConfirmationError('This occurrence is already logged, but the schedule was moved back. Review the recurring schedule before continuing.')
      }
      return { created: false, transactionId, recurringItem: latest }
    }
    if (!latest || !latest.isActive || !sameSchedule(latest, item)) {
      throw new RecurringConfirmationError('This recurring schedule changed or is no longer active. Refresh the page before confirming.')
    }
    if (latest.nextDueDate.toMillis() > now.toMillis()) {
      throw new RecurringConfirmationError('This recurring expense is not due yet.')
    }
    const validation = TransactionSchema.safeParse({
      amountPaise, description: latest.description, categoryId: latest.categoryId,
      type: 'recurring', date: latest.nextDueDate.toDate().toISOString(),
      paymentMode: latest.paymentMode, paymentAccountId: latest.paymentAccountId,
      tripId: null, personId: null, tags: [], notes: `Auto-logged from recurring: ${latest.description}`,
      receiptUrl: null, recoverablePaise: 0, splits: [], reimbursementStatus: 'none',
    })
    if (!validation.success) {
      throw new RecurringConfirmationError('Check the amount, category and payment account in this recurring expense before confirming.')
    }
    const nextDueDate = Timestamp.fromDate(computeNextDueDate(
      latest.nextDueDate.toDate(), latest.frequency, latest.dayOfMonth, latest.dayOfWeek
    ))
    txn.set(expenseRef, {
      ...validation.data, date: latest.nextDueDate, id: transactionId,
      recurringItemId: item.id, recurringOccurrenceDate: latest.nextDueDate,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    })
    txn.update(scheduleRef, { nextDueDate, lastGeneratedDate: serverTimestamp(), updatedAt: serverTimestamp() })
    // Cache invalidation commits with the expense, including when the response is lost.
    txn.delete(doc(db, 'users', uid, 'insights', 'summary'))
    return {
      created: true,
      transactionId,
      recurringItem: { ...latest, nextDueDate, lastGeneratedDate: now, updatedAt: now },
    }
  })
}

export function recurringConfirmationErrorMessage(error: unknown): string {
  if (error instanceof RecurringConfirmationError) return error.message
  return 'Confirmation could not be verified. Check your connection and retry this occurrence. If it was already saved, retrying will not log it again.'
}

export function recurringSaveErrorMessage(error: unknown): string {
  if (error instanceof RecurringConfirmationError) return error.message
  return 'Could not save this recurring expense. Check your connection and try again.'
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

// ── Re-export Pure Recurring Accounting Helpers ──────────────────────────────
export {
  calculateNormalizedMonthlyCommitmentPaise,
  calculateRecurringTransactionsNetSpend,
  calculateRecurringTransactionsGrossOutflow,
  calculateRecurringRecoverablesSummary,
} from '@/utils/recurringMath'
