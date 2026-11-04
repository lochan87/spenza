import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  getCountFromServer,
  query,
  where,
  orderBy,
  Timestamp,
} from 'firebase/firestore'
import {
  format,
  startOfMonth,
  endOfMonth,
} from 'date-fns'
import { db } from '@/firebase/config'
import { getCategories } from '@/services/transactions'
import { getNetSpendPaise } from '@/utils/splitMath'
import {
  deriveInsightsData,
  INSIGHTS_SCHEMA_VERSION,
} from '@/utils/insightsMath'
import type {
  Transaction,
  InsightsSummary,
} from '@/types'

export * from '@/utils/insightsMath'

const summaryRef = (uid: string) => doc(db, 'users', uid, 'insights', 'summary')

/**
 * CHOSEN APPROACH: On-demand cached summary document (`users/{uid}/insights/summary`).
 *
 * Why all extended insights live in this single summary document:
 * - Computing 12-month trends, MoM comparison, category trends, day-of-week stats,
 *   and all-time records in memory from `allTxns` takes <5ms once transactions are fetched.
 * - The resulting JSON document is ~4 KB (well under Firestore's 1 MB doc limit),
 *   keeping repeat page visits at 1 document read + 1 count check.
 * - Staleness detection checks: (a) 7-day TTL, (b) live transaction count mismatch,
 *   (c) current calendar month rollover (`computedMonthKey`), and (d) presence of extended fields.
 */

export async function getCachedInsights(uid: string): Promise<InsightsSummary | null> {
  const snap = await getDoc(summaryRef(uid))
  if (!snap.exists()) return null
  return snap.data() as InsightsSummary
}

/** Delete the cached insights summary document (called on edits/bulk clear/import). Returns true on success. */
export async function invalidateInsightsCache(uid: string): Promise<boolean> {
  try {
    await deleteDoc(summaryRef(uid))
    return true
  } catch (err) {
    console.error('[Spenza Insights] Failed to invalidate insights cache:', err)
    return false
  }
}

/** Get the current number of transactions in Firestore (fast count aggregation with offline fallback) */
export async function getLiveTransactionCount(uid: string): Promise<number> {
  const coll = collection(db, 'users', uid, 'transactions')
  try {
    const countSnap = await getCountFromServer(coll)
    return countSnap.data().count
  } catch {
    const snap = await getDocs(coll)
    return snap.size
  }
}

/** Live query of the current calendar month's total spend in paise (for the Spending Pace card) */
export async function getCurrentMonthSpendTotal(uid: string): Promise<number> {
  const now = new Date()
  const start = Timestamp.fromDate(startOfMonth(now))
  const end = Timestamp.fromDate(endOfMonth(now))
  const snap = await getDocs(
    query(
      collection(db, 'users', uid, 'transactions'),
      where('date', '>=', start),
      where('date', '<=', end)
    )
  )
  return snap.docs.reduce((sum, d) => sum + getNetSpendPaise(d.data() as Transaction), 0)
}

/** True if the cached summary is fresh (computed within last 7 days and in the same calendar month) */
export function isCacheFresh(summary: InsightsSummary): boolean {
  const computed = summary.computedAt.toDate()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const currentMonthKey = format(new Date(), 'yyyy-MM')
  if (summary.computedMonthKey && summary.computedMonthKey !== currentMonthKey) {
    return false
  }
  return computed > sevenDaysAgo
}

/**
 * True if the cached summary no longer reflects the current transactions collection
 * or was computed with an older schemaVersion.
 */
export function isCacheStaleAgainstCount(summary: InsightsSummary, liveCount: number): boolean {
  if (liveCount < 3) return true
  if (typeof summary.transactionCount !== 'number') return true
  if (
    typeof summary.schemaVersion !== 'number' ||
    summary.schemaVersion < INSIGHTS_SCHEMA_VERSION
  ) {
    return true
  }
  const diff = Math.abs(liveCount - summary.transactionCount)
  const pctDiff = diff / Math.max(1, summary.transactionCount)
  return diff >= 5 || pctDiff >= 0.1
}

/** Fetch all transactions and compute + persist the insights summary.
 * Returns null (and deletes any stale cached doc) if there are fewer than 3 transactions. */
export async function computeAndCacheInsights(uid: string): Promise<InsightsSummary | null> {
  const snap = await getDocs(
    query(collection(db, 'users', uid, 'transactions'), orderBy('date', 'asc'))
  )
  const allTxns = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction)

  // Not enough data to generate meaningful insights — ensure any stale cached summary is removed
  if (allTxns.length < 3) {
    await invalidateInsightsCache(uid)
    return null
  }

  const categories = await getCategories(uid)
  const summary = deriveInsightsData(allTxns, categories, new Date())
  if (!summary) {
    await invalidateInsightsCache(uid)
    return null
  }

  await setDoc(summaryRef(uid), summary)
  return summary
}
