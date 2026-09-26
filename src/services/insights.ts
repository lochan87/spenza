import {
  collection, doc, setDoc, getDoc, getDocs,
  query, orderBy, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { getYear, format } from 'date-fns'
import { db } from '@/firebase/config'
import { getCategories } from '@/services/transactions'
import type { Transaction, InsightsSummary } from '@/types'

const summaryRef = (uid: string) => doc(db, 'users', uid, 'insights', 'summary')

/**
 * CHOSEN APPROACH: On-demand cached summary document.
 *
 * The insights summary is stored at users/{uid}/insights/summary.
 * - On page load: read 1 doc. If it's <7 days old, use cached data.
 * - If stale/missing: show a "Compute Insights" prompt (user initiates).
 * - "Refresh" button always triggers a recompute.
 *
 * TRADEOFFS vs live query on every visit:
 *   ✅ Fast on repeat visits — 1 doc read instead of O(all transactions)
 *   ✅ User controls freshness via explicit "Refresh" button
 *   ✅ Firestore read cost stays flat as history grows
 *   ❌ Can be up to 7 days stale without manual refresh
 *   ❌ First-time compute reads all transactions (one-time cost per 7 days)
 */

export async function getCachedInsights(uid: string): Promise<InsightsSummary | null> {
  const snap = await getDoc(summaryRef(uid))
  if (!snap.exists()) return null
  return snap.data() as InsightsSummary
}

/** True if the cached summary is fresh (computed within last 7 days) */
export function isCacheFresh(summary: InsightsSummary): boolean {
  const computed = summary.computedAt.toDate()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  return computed > sevenDaysAgo
}

/** Fetch all transactions and compute + persist the insights summary */
export async function computeAndCacheInsights(uid: string): Promise<InsightsSummary> {
  // Read ALL transactions — expensive but infrequent (7-day cache)
  const snap = await getDocs(
    query(collection(db, 'users', uid, 'transactions'), orderBy('date', 'asc'))
  )
  const allTxns = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction)
  const categories = await getCategories(uid)

  const catMap = new Map(categories.map(c => [c.id, c.name]))
  const toDate = (ts: any): Date => ts?.toDate?.() ?? new Date(ts)

  // 1. Highest spending month
  const monthTotals = new Map<string, number>()
  for (const tx of allTxns) {
    const k = format(toDate(tx.date), 'yyyy-MM')
    monthTotals.set(k, (monthTotals.get(k) ?? 0) + tx.amountPaise)
  }
  let highestSpendingMonth: InsightsSummary['highestSpendingMonth'] = null
  for (const [monthKey, totalPaise] of monthTotals) {
    if (!highestSpendingMonth || totalPaise > highestSpendingMonth.totalPaise) {
      highestSpendingMonth = { monthKey, totalPaise }
    }
  }

  // 2. Most frequent category (by transaction count)
  const catCount = new Map<string, number>()
  for (const tx of allTxns) {
    catCount.set(tx.categoryId, (catCount.get(tx.categoryId) ?? 0) + 1)
  }
  let mostFrequentCategory: InsightsSummary['mostFrequentCategory'] = null
  for (const [categoryId, count] of catCount) {
    if (!mostFrequentCategory || count > mostFrequentCategory.count) {
      mostFrequentCategory = { categoryId, name: catMap.get(categoryId) ?? 'Other', count }
    }
  }

  // 3. Most frequent small description (sub-₹100 = sub-10000 paise)
  const smallTxns = allTxns.filter(t => t.amountPaise <= 10_000)
  const descCount = new Map<string, number>()
  for (const tx of smallTxns) {
    if (tx.description) {
      descCount.set(tx.description, (descCount.get(tx.description) ?? 0) + 1)
    }
  }
  let mostFrequentSmallDesc: InsightsSummary['mostFrequentSmallDesc'] = null
  for (const [description, count] of descCount) {
    if (count >= 2 && (!mostFrequentSmallDesc || count > mostFrequentSmallDesc.count)) {
      mostFrequentSmallDesc = { description, count }
    }
  }

  // 4. Largest single expense
  let largestSingleExpense: InsightsSummary['largestSingleExpense'] = null
  for (const tx of allTxns) {
    if (!largestSingleExpense || tx.amountPaise > largestSingleExpense.amountPaise) {
      largestSingleExpense = {
        id: tx.id,
        description: tx.description,
        amountPaise: tx.amountPaise,
        date: tx.date as unknown as Timestamp,
      }
    }
  }

  // 5. Year-over-year totals
  const yearTotals = new Map<number, number>()
  for (const tx of allTxns) {
    const y = getYear(toDate(tx.date))
    yearTotals.set(y, (yearTotals.get(y) ?? 0) + tx.amountPaise)
  }
  const yearlyTotals = [...yearTotals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, totalPaise]) => ({ year, totalPaise }))

  // 6. Gift & events total (all-time)
  const giftEventTotalPaise = allTxns
    .filter(t => t.type === 'gift-event')
    .reduce((s, t) => s + t.amountPaise, 0)

  // 7. Trip spending total (all-time)
  const tripTotalPaise = allTxns
    .filter(t => t.type === 'trip' || t.tripId != null)
    .reduce((s, t) => s + t.amountPaise, 0)

  // 8. Auto-generated sentence for highest year
  const highestYear = yearlyTotals.reduce<{ year: number; totalPaise: number } | null>(
    (best, y) => (!best || y.totalPaise > best.totalPaise ? y : best), null
  )
  let highestYearInsight = ''
  if (highestYear) {
    const txnsInYear = allTxns.filter(t => getYear(toDate(t.date)) === highestYear.year)
    const specialTxns = txnsInYear.filter(t => ['one-time', 'trip', 'gift-event'].includes(t.type))
    const specialTotal = specialTxns.reduce((s, t) => s + t.amountPaise, 0)
    const specialPct = highestYear.totalPaise > 0 ? specialTotal / highestYear.totalPaise : 0

    if (specialPct > 0.3) {
      // One-time/trip spending is driving the year
      const specialCatMap = new Map<string, number>()
      for (const tx of specialTxns) {
        specialCatMap.set(tx.categoryId, (specialCatMap.get(tx.categoryId) ?? 0) + tx.amountPaise)
      }
      const topSpecialCats = [...specialCatMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([id]) => catMap.get(id) ?? 'Other')

      const catNames = topSpecialCats.join(' and ')
      const isCurrentYear = highestYear.year === new Date().getFullYear()
      const verb = isCurrentYear ? 'is' : 'was'
      highestYearInsight = `${highestYear.year} spending ${verb} unusually high because of large one-time ${catNames} expenses.`
    } else {
      // Regular spending drove it
      const yrCatMap = new Map<string, number>()
      for (const tx of txnsInYear) {
        yrCatMap.set(tx.categoryId, (yrCatMap.get(tx.categoryId) ?? 0) + tx.amountPaise)
      }
      const topCats = [...yrCatMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([id]) => catMap.get(id) ?? 'Other')
      const catNames = topCats.join(' and ')
      const isCurrentYear = highestYear.year === new Date().getFullYear()
      const verb = isCurrentYear ? 'has' : 'had'
      highestYearInsight = `${highestYear.year} ${verb} high regular ${catNames} spending.`
    }
  }

  const summary: InsightsSummary = {
    computedAt: Timestamp.now(),
    highestSpendingMonth,
    mostFrequentCategory,
    mostFrequentSmallDesc,
    largestSingleExpense,
    yearlyTotals,
    giftEventTotalPaise,
    tripTotalPaise,
    highestYearInsight,
  }

  // Persist to Firestore
  await setDoc(summaryRef(uid), summary)
  return summary
}
