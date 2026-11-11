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
  Timestamp,
} from 'firebase/firestore'
import {
  format,
  startOfMonth,
} from 'date-fns'
import { db } from '@/firebase/config'
import { getCategories } from '@/services/transactions'
import { getNetSpendPaise } from '@/utils/splitMath'
import {
  deriveInsightsData,
  INSIGHTS_SCHEMA_VERSION,
  getInsightsDate,
} from '@/utils/insightsMath'
import type {
  Transaction,
  InsightsSummary,
} from '@/types'

export * from '@/utils/insightsMath'

const dirtyCaches = new Set<string>()
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
  if (dirtyCaches.has(uid)) return null
  const snap = await getDoc(summaryRef(uid))
  if (!snap.exists()) return null
  return snap.data() as InsightsSummary
}

/** Delete the cached insights summary document (called on edits/bulk clear/import). Returns true on success. */
export async function invalidateInsightsCache(uid: string): Promise<boolean> {
  dirtyCaches.add(uid)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const acknowledgment = deleteDoc(summaryRef(uid)).then(() => {
      dirtyCaches.delete(uid)
      return true
    }, err => {
      console.error('[Spenza Insights] Failed to invalidate insights cache:', err)
      return false
    })
    // Cache maintenance must not block a confirmed financial write indefinitely.
    // Pending/failed invalidation is never reported as successful.
    return await Promise.race([acknowledgment, new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), 300)
    })])
  } catch (err) {
    console.error('[Spenza Insights] Failed to invalidate insights cache:', err)
    return false
  } finally { clearTimeout(timer) }
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

/** Live query of the current calendar month's total spend in paise (for the Spending Pace card).
 * Ends at the reference time so future-dated records cannot inflate the pace. */
export async function getCurrentMonthSpendTotal(uid: string, now: Date = new Date()): Promise<number> {
  const monthStart = startOfMonth(now)
  const start = Timestamp.fromDate(monthStart)
  const end = Timestamp.fromDate(now)
  const snap = await getDocs(
    query(
      collection(db, 'users', uid, 'transactions'),
      where('date', '>=', start),
      where('date', '<=', end)
    )
  )
  return snap.docs.reduce((sum, d) => {
    const tx = d.data() as Transaction
    const date = getInsightsDate(tx.date)
    return date && date >= monthStart && date <= now ? sum + getNetSpendPaise(tx) : sum
  }, 0)
}

/** True if the cached summary is fresh (computed within last 7 days and in the same calendar month) */
export function isCacheFresh(summary: InsightsSummary, now: Date = new Date()): boolean {
  // Older summaries persisted a plain seconds/nanoseconds map, not a Timestamp.
  const value = summary.computedAt
  const computed = getInsightsDate(value) ?? (value && Number.isFinite(value.seconds)
    ? new Date(value.seconds * 1000) : null)
  if (!computed || !Number.isFinite(computed.getTime())) return false
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const currentMonthKey = format(now, 'yyyy-MM')
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
export async function computeAndCacheInsights(
  uid: string,
  now: Date = new Date()
): Promise<InsightsSummary | null> {
  // No orderBy: Firestore excludes documents missing the ordered field. Keep
  // those records for count validation and date-independent all-time metrics.
  const snap = await getDocs(collection(db, 'users', uid, 'transactions'))
  if (snap.metadata?.fromCache || snap.metadata?.hasPendingWrites) {
    throw new Error('Insights require synchronized server data. Reconnect and wait for pending changes to sync, then retry.')
  }
  const allTxns = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction)
  // Preserve chronological tie-breaking from the former ordered query, with
  // undated records last rather than omitted.
  allTxns.sort((a, b) =>
    (getInsightsDate(a.date)?.getTime() ?? Infinity) -
    (getInsightsDate(b.date)?.getTime() ?? Infinity)
  )

  // Not enough data to generate meaningful insights — ensure any stale cached summary is removed
  if (allTxns.length < 3) {
    await invalidateInsightsCache(uid)
    return null
  }

  const categories = await getCategories(uid)
  const summary = deriveInsightsData(allTxns, categories, now)
  if (!summary) {
    await invalidateInsightsCache(uid)
    return null
  }

  summary.computedAt = Timestamp.fromDate(now)
  // The summary is derived data: a slow cache write must not hide valid analytics.
  // Do not enqueue a cache write while known offline.
  if (typeof navigator === 'undefined' || navigator.onLine) {
    void setDoc(summaryRef(uid), summary).catch(err => {
      console.warn('[Spenza Insights] Summary displayed but cache persistence failed:', err)
      dirtyCaches.add(uid)
    })
  }
  return summary
}
