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
  getYear,
  format,
  subMonths,
  startOfMonth,
  endOfMonth,
  startOfDay,
  differenceInCalendarDays,
  parseISO,
} from 'date-fns'
import { db } from '@/firebase/config'
import { getCategories } from '@/services/transactions'
import { formatINR } from '@/utils/format'
import type {
  Transaction,
  InsightsSummary,
  MonthlyTrendPoint,
  MonthOverMonthComparison,
  CategoryShiftItem,
  CategoryMonthlyTrend,
  DayOfWeekStats,
  DayOfWeekItem,
  HighestSpendingDay,
  LoggingStreakInfo,
  AvgTransactionSizeInfo,
  MostExpensiveCategoryInfo,
  PaymentModeInsightInfo,
  PaymentMode,
} from '@/types'

const summaryRef = (uid: string) => doc(db, 'users', uid, 'insights', 'summary')

/** Current schema version for cached InsightsSummary documents */
export const INSIGHTS_SCHEMA_VERSION = 3

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
  return snap.docs.reduce((sum, d) => sum + ((d.data().amountPaise as number) ?? 0), 0)
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

const DAY_META: Array<{ index: number; shortName: string; fullName: string; isWeekend: boolean }> = [
  { index: 1, shortName: 'Mon', fullName: 'Monday', isWeekend: false },
  { index: 2, shortName: 'Tue', fullName: 'Tuesday', isWeekend: false },
  { index: 3, shortName: 'Wed', fullName: 'Wednesday', isWeekend: false },
  { index: 4, shortName: 'Thu', fullName: 'Thursday', isWeekend: false },
  { index: 5, shortName: 'Fri', fullName: 'Friday', isWeekend: false },
  { index: 6, shortName: 'Sat', fullName: 'Saturday', isWeekend: true },
  { index: 0, shortName: 'Sun', fullName: 'Sunday', isWeekend: true },
]

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
  const catMap = new Map(categories.map(c => [c.id, c.name]))
  const toDate = (ts: any): Date => ts?.toDate?.() ?? new Date(ts)

  const now = new Date()
  const currentMonthKey = format(now, 'yyyy-MM')
  const lastMonthDate = subMonths(now, 1)
  const lastMonthKey = format(lastMonthDate, 'yyyy-MM')

  const totalAllTimePaise = allTxns.reduce((s, t) => s + t.amountPaise, 0)

  // ── 1. Highest spending month & month maps ─────────────────────────────────
  const monthTotals = new Map<string, number>()
  const monthTxCounts = new Map<string, number>()
  const monthCatTotals = new Map<string, Map<string, number>>()

  for (const tx of allTxns) {
    const d = toDate(tx.date)
    const k = format(d, 'yyyy-MM')
    monthTotals.set(k, (monthTotals.get(k) ?? 0) + tx.amountPaise)
    monthTxCounts.set(k, (monthTxCounts.get(k) ?? 0) + 1)

    if (!monthCatTotals.has(k)) monthCatTotals.set(k, new Map())
    const cMap = monthCatTotals.get(k)!
    cMap.set(tx.categoryId, (cMap.get(tx.categoryId) ?? 0) + tx.amountPaise)
  }

  let highestSpendingMonth: InsightsSummary['highestSpendingMonth'] = null
  for (const [monthKey, totalPaise] of monthTotals) {
    if (!highestSpendingMonth || totalPaise > highestSpendingMonth.totalPaise) {
      highestSpendingMonth = { monthKey, totalPaise }
    }
  }

  // ── 2. Most frequent & most expensive category (all-time) ──────────────────
  const catCount = new Map<string, number>()
  const catTotalPaise = new Map<string, number>()
  for (const tx of allTxns) {
    catCount.set(tx.categoryId, (catCount.get(tx.categoryId) ?? 0) + 1)
    catTotalPaise.set(tx.categoryId, (catTotalPaise.get(tx.categoryId) ?? 0) + tx.amountPaise)
  }

  let mostFrequentCategory: InsightsSummary['mostFrequentCategory'] = null
  for (const [categoryId, count] of catCount) {
    if (!mostFrequentCategory || count > mostFrequentCategory.count) {
      mostFrequentCategory = { categoryId, name: catMap.get(categoryId) ?? 'Other', count }
    }
  }

  let mostExpensiveCategory: MostExpensiveCategoryInfo | null = null
  for (const [categoryId, totalPaise] of catTotalPaise) {
    if (!mostExpensiveCategory || totalPaise > mostExpensiveCategory.totalPaise) {
      mostExpensiveCategory = {
        categoryId,
        name: catMap.get(categoryId) ?? 'Other',
        totalPaise,
        sharePct: totalAllTimePaise > 0 ? Math.round((totalPaise / totalAllTimePaise) * 100) : 0,
      }
    }
  }

  // ── 3. Most frequent small description (sub-₹100 = sub-10000 paise) ────────
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

  // ── 4. Largest single expense ──────────────────────────────────────────────
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

  // ── 5. Year-over-year totals ───────────────────────────────────────────────
  const yearTotals = new Map<number, number>()
  for (const tx of allTxns) {
    const y = getYear(toDate(tx.date))
    yearTotals.set(y, (yearTotals.get(y) ?? 0) + tx.amountPaise)
  }
  const yearlyTotals = [...yearTotals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, totalPaise]) => ({ year, totalPaise }))

  // ── 6. Gift & events + Trip totals (all-time) ──────────────────────────────
  const giftEventTotalPaise = allTxns
    .filter(t => t.type === 'gift-event')
    .reduce((s, t) => s + t.amountPaise, 0)

  const tripTotalPaise = allTxns
    .filter(t => t.type === 'trip' || t.tripId != null)
    .reduce((s, t) => s + t.amountPaise, 0)

  // ── 7. Auto-generated sentence for highest year ────────────────────────────
  const highestYear = yearlyTotals.reduce<{ year: number; totalPaise: number } | null>(
    (best, y) => (!best || y.totalPaise > best.totalPaise ? y : best),
    null
  )
  let highestYearInsight = ''
  if (highestYear) {
    const txnsInYear = allTxns.filter(t => getYear(toDate(t.date)) === highestYear.year)
    const specialTxns = txnsInYear.filter(t => ['one-time', 'trip', 'gift-event'].includes(t.type))
    const specialTotal = specialTxns.reduce((s, t) => s + t.amountPaise, 0)
    const specialPct = highestYear.totalPaise > 0 ? specialTotal / highestYear.totalPaise : 0

    if (specialPct > 0.3) {
      const specialCatMap = new Map<string, number>()
      for (const tx of specialTxns) {
        specialCatMap.set(tx.categoryId, (specialCatMap.get(tx.categoryId) ?? 0) + tx.amountPaise)
      }
      const topSpecialCats = [...specialCatMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([id]) => catMap.get(id) ?? 'Other')

      const catNames = topSpecialCats.join(' and ')
      const isCurrentYear = highestYear.year === now.getFullYear()
      const verb = isCurrentYear ? 'is' : 'was'
      highestYearInsight = `${highestYear.year} spending ${verb} unusually high because of large one-time ${catNames} expenses.`
    } else {
      const yrCatMap = new Map<string, number>()
      for (const tx of txnsInYear) {
        yrCatMap.set(tx.categoryId, (yrCatMap.get(tx.categoryId) ?? 0) + tx.amountPaise)
      }
      const topCats = [...yrCatMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([id]) => catMap.get(id) ?? 'Other')
      const catNames = topCats.join(' and ')
      const isCurrentYear = highestYear.year === now.getFullYear()
      const verb = isCurrentYear ? 'has' : 'had'
      highestYearInsight = `${highestYear.year} ${verb} high regular ${catNames} spending.`
    }
  }

  // ── 8. Last 12 Months Trend (Section 1) ────────────────────────────────────
  // If user has recent data in the last 12 months, anchor window to `now`.
  // If all transactions are historical (e.g. imported from an earlier year), anchor to the latest transaction's month
  // OR always include current month — let's check: anchoring to `now` covers the last 12 calendar months,
  // and if the last 12 months are completely empty (0 txns) because of older historical data, we anchor to the latest tx month!
  const hasAnyInLast12M = Array.from({ length: 12 }, (_, idx) =>
    format(subMonths(now, idx), 'yyyy-MM')
  ).some(k => (monthTotals.get(k) ?? 0) > 0)

  const latestTxDate = toDate(allTxns[allTxns.length - 1].date)
  const anchorDate = hasAnyInLast12M ? now : latestTxDate

  const raw12Months = Array.from({ length: 12 }, (_, idx) => {
    const d = subMonths(anchorDate, 11 - idx)
    const monthKey = format(d, 'yyyy-MM')
    const totalPaise = monthTotals.get(monthKey) ?? 0
    const txCount = monthTxCounts.get(monthKey) ?? 0
    const cMap = monthCatTotals.get(monthKey)

    let topCategoryName: string | null = null
    let topCategoryPaise = 0
    if (cMap) {
      for (const [catId, amt] of cMap.entries()) {
        if (amt > topCategoryPaise) {
          topCategoryPaise = amt
          topCategoryName = catMap.get(catId) ?? 'Other'
        }
      }
    }

    return {
      monthKey,
      label: format(d, "MMM ''yy"),
      fullLabel: format(d, 'MMMM yyyy'),
      totalPaise,
      txCount,
      topCategoryName,
      topCategoryPaise,
      isCurrentMonth: monthKey === currentMonthKey,
    }
  })

  const nonZero12m = raw12Months.filter(m => m.totalPaise > 0)
  const avg12mPaise =
    nonZero12m.length > 0
      ? nonZero12m.reduce((s, m) => s + m.totalPaise, 0) / nonZero12m.length
      : 0

  const monthlyTrend: MonthlyTrendPoint[] = raw12Months.map((m, idx) => {
    const prev = idx > 0 ? raw12Months[idx - 1] : null
    const pctChangeVsPrev =
      prev && prev.totalPaise > 0
        ? Math.round(((m.totalPaise - prev.totalPaise) / prev.totalPaise) * 100)
        : null
    const isOutlier =
      nonZero12m.length >= 2 && avg12mPaise > 0 && m.totalPaise > avg12mPaise * 1.5

    return {
      ...m,
      pctChangeVsPrev,
      isOutlier,
    }
  })

  // ── 9. Month-over-Month Comparison (Section 2) ─────────────────────────────
  // Compare `thisMonthKey` vs `lastMonthKey` (or if both are 0 in historical-only data, compare the latest 2 months in window)
  const compThisDate =
    (monthTotals.get(currentMonthKey) ?? 0) > 0 || (monthTotals.get(lastMonthKey) ?? 0) > 0
      ? now
      : anchorDate
  const compLastDate = subMonths(compThisDate, 1)
  const compThisKey = format(compThisDate, 'yyyy-MM')
  const compLastKey = format(compLastDate, 'yyyy-MM')

  const thisMonthPaise = monthTotals.get(compThisKey) ?? 0
  const lastMonthPaise = monthTotals.get(compLastKey) ?? 0
  const diffPaise = thisMonthPaise - lastMonthPaise
  const pctChange =
    lastMonthPaise > 0 ? Math.round((diffPaise / lastMonthPaise) * 100) : null
  const thisMonthTxCount = monthTxCounts.get(compThisKey) ?? 0
  const lastMonthTxCount = monthTxCounts.get(compLastKey) ?? 0

  const thisCats = monthCatTotals.get(compThisKey) ?? new Map<string, number>()
  const lastCats = monthCatTotals.get(compLastKey) ?? new Map<string, number>()
  const allCompCatIds = new Set([...thisCats.keys(), ...lastCats.keys()])

  let biggestIncrease: CategoryShiftItem | null = null
  let biggestDecrease: CategoryShiftItem | null = null

  for (const catId of allCompCatIds) {
    const tAmt = thisCats.get(catId) ?? 0
    const lAmt = lastCats.get(catId) ?? 0
    const dAmt = tAmt - lAmt
    const cPct = lAmt > 0 ? Math.round((dAmt / lAmt) * 100) : null
    const item: CategoryShiftItem = {
      categoryId: catId,
      name: catMap.get(catId) ?? 'Other',
      thisMonthPaise: tAmt,
      lastMonthPaise: lAmt,
      diffPaise: dAmt,
      pctChange: cPct,
    }
    if (dAmt > 0 && (!biggestIncrease || dAmt > biggestIncrease.diffPaise)) {
      biggestIncrease = item
    }
    if (dAmt < 0 && (!biggestDecrease || dAmt < biggestDecrease.diffPaise)) {
      biggestDecrease = item
    }
  }

  const thisMonthLabel = format(compThisDate, 'MMMM yyyy')
  const lastMonthLabel = format(compLastDate, 'MMMM yyyy')
  const lastMonthShort = format(compLastDate, 'MMMM')
  const isComparingCurrentMonth = compThisKey === currentMonthKey

  let momSummarySentence = ''
  if (lastMonthPaise === 0 && thisMonthPaise > 0) {
    momSummarySentence = `You've logged ${formatINR(thisMonthPaise)} across ${thisMonthTxCount} expense${
      thisMonthTxCount === 1 ? '' : 's'
    } in ${format(compThisDate, 'MMMM')}${
      biggestIncrease ? `, led by ${biggestIncrease.name} (${formatINR(biggestIncrease.thisMonthPaise)})` : ''
    }.`
  } else if (thisMonthPaise === 0 && lastMonthPaise > 0) {
    momSummarySentence = `No expenses logged yet for ${format(compThisDate, 'MMMM')} compared to ${formatINR(
      lastMonthPaise
    )} in ${lastMonthShort}.`
  } else if (diffPaise > 0) {
    momSummarySentence = `You spent ${formatINR(diffPaise)} more ${
      isComparingCurrentMonth ? 'this month' : `in ${format(compThisDate, 'MMMM')}`
    } than ${lastMonthShort}${
      biggestIncrease
        ? `, mainly driven by a ${formatINR(biggestIncrease.diffPaise)} increase in ${biggestIncrease.name}`
        : ''
    }.`
  } else if (diffPaise < 0) {
    momSummarySentence = `You spent ${formatINR(Math.abs(diffPaise))} less ${
      isComparingCurrentMonth ? 'this month so far' : `in ${format(compThisDate, 'MMMM')}`
    } than ${lastMonthShort}${
      biggestDecrease
        ? `, helped by a ${formatINR(Math.abs(biggestDecrease.diffPaise))} drop in ${biggestDecrease.name}`
        : ''
    }.`
  } else if (thisMonthPaise > 0) {
    momSummarySentence = `Your spending in ${format(compThisDate, 'MMMM')} matches ${lastMonthShort} at ${formatINR(
      thisMonthPaise
    )}.`
  }

  const monthComparison: MonthOverMonthComparison = {
    thisMonthKey: compThisKey,
    lastMonthKey: compLastKey,
    thisMonthLabel,
    lastMonthLabel,
    thisMonthPaise,
    lastMonthPaise,
    diffPaise,
    pctChange,
    thisMonthTxCount,
    lastMonthTxCount,
    biggestIncrease,
    biggestDecrease,
    summarySentence: momSummarySentence,
  }

  // ── 10. Category Trend Over Time (Section 3) ───────────────────────────────
  const activeCatIds = [...catTotalPaise.keys()]
  const categoryMonthlyTrends: CategoryMonthlyTrend[] = activeCatIds
    .map(categoryId => {
      const name = catMap.get(categoryId) ?? 'Other'
      let total12mPaise = 0
      let peakMonthLabel: string | null = null
      let peakMonthPaise = 0

      const months = raw12Months.map(m => {
        const cMap = monthCatTotals.get(m.monthKey)
        const amt = cMap?.get(categoryId) ?? 0
        total12mPaise += amt
        if (amt > peakMonthPaise) {
          peakMonthPaise = amt
          peakMonthLabel = m.label
        }
        return {
          monthKey: m.monthKey,
          label: m.label,
          totalPaise: amt,
          isCurrentMonth: m.isCurrentMonth,
        }
      })

      return {
        categoryId,
        name,
        total12mPaise,
        avgMonthlyPaise: Math.round(total12mPaise / 12),
        peakMonthLabel,
        peakMonthPaise,
        months,
      }
    })
    .sort((a, b) => {
      if (b.total12mPaise !== a.total12mPaise) return b.total12mPaise - a.total12mPaise
      return (catTotalPaise.get(b.categoryId) ?? 0) - (catTotalPaise.get(a.categoryId) ?? 0)
    })

  // ── 11. Day-of-Week / Spending Pattern (Section 4) ─────────────────────────
  const dowTotals = new Map<number, number>()
  const dowTxCounts = new Map<number, number>()
  const dowCats = new Map<number, Map<string, number>>()
  const weekendCats = new Map<string, number>()

  for (const tx of allTxns) {
    const d = toDate(tx.date)
    const dayIdx = d.getDay() // 0=Sun..6=Sat

    dowTotals.set(dayIdx, (dowTotals.get(dayIdx) ?? 0) + tx.amountPaise)
    dowTxCounts.set(dayIdx, (dowTxCounts.get(dayIdx) ?? 0) + 1)

    if (!dowCats.has(dayIdx)) dowCats.set(dayIdx, new Map())
    const dc = dowCats.get(dayIdx)!
    dc.set(tx.categoryId, (dc.get(tx.categoryId) ?? 0) + tx.amountPaise)

    if (dayIdx === 0 || dayIdx === 6) {
      weekendCats.set(tx.categoryId, (weekendCats.get(tx.categoryId) ?? 0) + tx.amountPaise)
    }
  }

  // Count actual calendar occurrences of each weekday across the data's date span
  const firstTxDay = startOfDay(toDate(allTxns[0].date))
  const lastTxDay = startOfDay(toDate(allTxns[allTxns.length - 1].date))
  const totalSpanDays = Math.max(1, differenceInCalendarDays(lastTxDay, firstTxDay) + 1)
  const fullWeeks = Math.floor(totalSpanDays / 7)
  const remainderDays = totalSpanDays % 7
  const firstDayOfWeek = firstTxDay.getDay()

  const getCalendarOccurrences = (dayIdx: number): number => {
    const offset = (dayIdx - firstDayOfWeek + 7) % 7
    return fullWeeks + (offset < remainderDays ? 1 : 0)
  }

  const days: DayOfWeekItem[] = DAY_META.map(meta => {
    const totalPaise = dowTotals.get(meta.index) ?? 0
    const txCount = dowTxCounts.get(meta.index) ?? 0
    const occurrences = Math.max(1, getCalendarOccurrences(meta.index))
    const avgPerOccurrencePaise = Math.round(totalPaise / occurrences)

    let topCategoryName: string | null = null
    let topCatAmt = 0
    const dc = dowCats.get(meta.index)
    if (dc) {
      for (const [cId, amt] of dc.entries()) {
        if (amt > topCatAmt) {
          topCatAmt = amt
          topCategoryName = catMap.get(cId) ?? 'Other'
        }
      }
    }

    return {
      dayIndex: meta.index,
      shortName: meta.shortName,
      fullName: meta.fullName,
      totalPaise,
      txCount,
      avgPerOccurrencePaise,
      topCategoryName,
      isWeekend: meta.isWeekend,
    }
  })

  const peakDay = days.reduce<DayOfWeekItem>(
    (best, d) => (d.avgPerOccurrencePaise > best.avgPerOccurrencePaise ? d : best),
    days[0]
  )

  const weekendTotalPaise = (dowTotals.get(0) ?? 0) + (dowTotals.get(6) ?? 0)
  const weekdayTotalPaise = totalAllTimePaise - weekendTotalPaise
  const weekendCalendarDays = Math.max(
    1,
    getCalendarOccurrences(0) + getCalendarOccurrences(6)
  )
  const weekdayCalendarDays = Math.max(
    1,
    getCalendarOccurrences(1) +
      getCalendarOccurrences(2) +
      getCalendarOccurrences(3) +
      getCalendarOccurrences(4) +
      getCalendarOccurrences(5)
  )

  const weekendDailyAvgPaise = Math.round(weekendTotalPaise / weekendCalendarDays)
  const weekdayDailyAvgPaise = Math.round(weekdayTotalPaise / weekdayCalendarDays)
  const weekendVsWeekdayPct =
    weekdayDailyAvgPaise > 0
      ? Math.round(((weekendDailyAvgPaise - weekdayDailyAvgPaise) / weekdayDailyAvgPaise) * 100)
      : null

  const topWeekendCategories = [...weekendCats.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([cId]) => catMap.get(cId) ?? 'Other')

  let patternSentence = ''
  if (weekendVsWeekdayPct !== null && weekendVsWeekdayPct >= 15 && topWeekendCategories.length > 0) {
    patternSentence = `You spend ${weekendVsWeekdayPct}% more per day on weekends, mostly on ${topWeekendCategories.join(
      ' and '
    )}.`
  } else if (weekendVsWeekdayPct !== null && weekendVsWeekdayPct <= -15) {
    patternSentence = `You spend ${Math.abs(weekendVsWeekdayPct)}% more per day on weekdays than weekends, peaking on ${
      peakDay.fullName
    }s${peakDay.topCategoryName ? ` (${peakDay.topCategoryName})` : ''}.`
  } else if (peakDay.totalPaise > 0) {
    patternSentence = `${peakDay.fullName} is your highest-spending day of the week${
      peakDay.topCategoryName ? `, mainly driven by ${peakDay.topCategoryName}` : ''
    }.`
  }

  const dayOfWeekStats: DayOfWeekStats = {
    days,
    peakDayName: peakDay.fullName,
    peakDayAvgPaise: peakDay.avgPerOccurrencePaise,
    peakDayTopCategory: peakDay.topCategoryName,
    weekendDailyAvgPaise,
    weekdayDailyAvgPaise,
    weekendVsWeekdayPct,
    topWeekendCategories,
    patternSentence,
  }

  // ── 12. Expanded Stat Cards (Section 6) ────────────────────────────────────

  // A. Highest single DAY of spending ever
  const dayMap = new Map<
    string,
    { totalPaise: number; txCount: number; topTx: Transaction }
  >()
  for (const tx of allTxns) {
    const dateStr = format(toDate(tx.date), 'yyyy-MM-dd')
    const existing = dayMap.get(dateStr)
    if (!existing) {
      dayMap.set(dateStr, { totalPaise: tx.amountPaise, txCount: 1, topTx: tx })
    } else {
      existing.totalPaise += tx.amountPaise
      existing.txCount += 1
      if (tx.amountPaise > existing.topTx.amountPaise) {
        existing.topTx = tx
      }
    }
  }

  let highestSpendingDay: HighestSpendingDay | null = null
  for (const [dateStr, info] of dayMap.entries()) {
    if (!highestSpendingDay || info.totalPaise > highestSpendingDay.totalPaise) {
      highestSpendingDay = {
        dateStr,
        totalPaise: info.totalPaise,
        txCount: info.txCount,
        topDescription: info.topTx.description,
        topCategoryName: catMap.get(info.topTx.categoryId) ?? 'Other',
      }
    }
  }

  // B. Longest daily logging streak
  const sortedDates = [...dayMap.keys()].sort()
  let longestDays = 0
  let longestStartDate: string | null = null
  let longestEndDate: string | null = null
  let curLen = 0
  let curStart: string | null = null

  for (let i = 0; i < sortedDates.length; i++) {
    const dStr = sortedDates[i]
    if (i === 0) {
      curLen = 1
      curStart = dStr
    } else {
      const prevD = parseISO(sortedDates[i - 1])
      const currD = parseISO(dStr)
      const diffDays = differenceInCalendarDays(currD, prevD)
      if (diffDays === 1) {
        curLen += 1
      } else {
        curLen = 1
        curStart = dStr
      }
    }
    if (curLen > longestDays) {
      longestDays = curLen
      longestStartDate = curStart
      longestEndDate = dStr
    }
  }

  // Check if current streak is active (last logged date is today or yesterday)
  let currentDays = 0
  if (sortedDates.length > 0) {
    const lastDateStr = sortedDates[sortedDates.length - 1]
    const daysSinceLast = differenceInCalendarDays(now, parseISO(lastDateStr))
    if (daysSinceLast <= 1) {
      currentDays = curLen
    }
  }

  const longestStreak: LoggingStreakInfo = {
    longestDays,
    longestStartDate,
    longestEndDate,
    currentDays,
  }

  // C. Average transaction size: All-time vs Last 3 months
  const allTimeAvgPaise = Math.round(totalAllTimePaise / allTxns.length)
  const threeMonthsAgo = subMonths(now, 3)
  const last3mTxns = allTxns.filter(t => toDate(t.date) >= threeMonthsAgo)
  const last3MonthsAvgPaise =
    last3mTxns.length > 0
      ? Math.round(last3mTxns.reduce((s, t) => s + t.amountPaise, 0) / last3mTxns.length)
      : null
  const avgPctDiff =
    last3MonthsAvgPaise !== null && allTimeAvgPaise > 0
      ? Math.round(((last3MonthsAvgPaise - allTimeAvgPaise) / allTimeAvgPaise) * 100)
      : null

  const avgTransactionSize: AvgTransactionSizeInfo = {
    allTimeAvgPaise,
    last3MonthsAvgPaise,
    pctDiff: avgPctDiff,
  }

  // D. Payment mode insight (prioritizing non-imported transactions if present, since Excel imports default to 'Other')
  const nonImportedTxns = allTxns.filter(t => !t.isImported)
  const paymentPool = nonImportedTxns.length >= 3 ? nonImportedTxns : allTxns
  const modeCounts = new Map<PaymentMode, number>()
  for (const tx of paymentPool) {
    const m = (tx.paymentMode || 'Other') as PaymentMode
    modeCounts.set(m, (modeCounts.get(m) ?? 0) + 1)
  }

  let dominantMode: PaymentMode = 'UPI'
  let dominantCount = 0
  for (const [m, count] of modeCounts.entries()) {
    if (count > dominantCount) {
      dominantCount = count
      dominantMode = m
    }
  }
  const dominantSharePct = Math.round((dominantCount / paymentPool.length) * 100)

  const sixMonthsAgo = subMonths(now, 6)
  const earlierPool = paymentPool.filter(t => toDate(t.date) < sixMonthsAgo)
  const recentPool = paymentPool.filter(t => toDate(t.date) >= sixMonthsAgo)

  const topModeIn = (list: Transaction[]): PaymentMode | null => {
    if (list.length < 2) return null
    const counts = new Map<PaymentMode, number>()
    for (const t of list) {
      const m = (t.paymentMode || 'Other') as PaymentMode
      counts.set(m, (counts.get(m) ?? 0) + 1)
    }
    let best: PaymentMode | null = null
    let bestC = 0
    for (const [m, c] of counts.entries()) {
      if (c > bestC) {
        bestC = c
        best = m
      }
    }
    return best
  }

  const earlierMode = topModeIn(earlierPool)
  const recentMode = topModeIn(recentPool)
  const shifted = Boolean(earlierMode && recentMode && earlierMode !== recentMode)

  const paymentModeInsight: PaymentModeInsightInfo = {
    dominantMode,
    dominantSharePct,
    dominantCount,
    recentMode,
    earlierMode,
    shifted,
    summaryText: shifted
      ? `Shifted from ${earlierMode} to ${recentMode} in the last 6 months`
      : `${dominantSharePct}% of tracked expenses (${dominantCount} txns)`,
  }

  // ── 13. Synthesized Insight Sentences (Section 7) ──────────────────────────
  const insightSentences = [
    momSummarySentence,
    highestYearInsight,
    patternSentence,
  ].filter(Boolean)

  const summary: InsightsSummary = {
    computedAt: Timestamp.now(),
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    computedMonthKey: currentMonthKey,
    transactionCount: allTxns.length,
    highestSpendingMonth,
    mostFrequentCategory,
    mostFrequentSmallDesc,
    largestSingleExpense,
    yearlyTotals,
    giftEventTotalPaise,
    tripTotalPaise,
    highestYearInsight,
    monthlyTrend,
    monthComparison,
    categoryMonthlyTrends,
    dayOfWeekStats,
    highestSpendingDay,
    longestStreak,
    avgTransactionSize,
    mostExpensiveCategory,
    paymentModeInsight,
    insightSentences,
  }

  await setDoc(summaryRef(uid), summary)
  return summary
}
