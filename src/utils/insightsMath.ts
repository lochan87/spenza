import {
  getYear,
  format,
  subMonths,
  startOfDay,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  parseISO,
  getDaysInMonth,
} from 'date-fns'
import type {
  Transaction,
  Category,
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
} from '../types/index.ts'
import { getNetSpendPaise } from './splitMath.ts'
import { formatINR } from './format.ts'

// Bumped when date-bucketing semantics change so previously cached summaries
// (which may include future-dated records) are recomputed instead of served.
export const INSIGHTS_SCHEMA_VERSION = 5

/** Validate once before a transaction participates in any date-dependent metric. */
export function getInsightsDate(value: unknown): Date | null {
  if (value == null) return null
  try {
    let date: unknown
    if (typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
      date = value.toDate()
    } else if (value instanceof Date) {
      date = value
    } else if (typeof value === 'string' || typeof value === 'number') {
      date = new Date(value)
    }
    return date instanceof Date && Number.isFinite(date.getTime()) ? date : null
  } catch {
    return null
  }
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

/**
 * Derives comprehensive spending insights, trends, MoM shifts, and analytics from transactions.
 *
 * Financial Invariants Guaranteed:
 * 1. All personal spending analytics (trends, categories, MoM, daily averages) use getNetSpendPaise(tx).
 * 2. 100% recoverable expenses fronted for others contribute ₹0 to personal spending.
 * 3. Shared expenses only contribute the user's personal net share.
 * 4. Repayments from participants never alter net spending, register as negative spikes, or appear as income.
 * 5. Payment mode usage analytics retain all actual payment methods used for outflow reconciliation.
 */
export function deriveInsightsData(
  allTxns: Transaction[],
  categories: Category[],
  now: Date = new Date()
): InsightsSummary | null {
  if (allTxns.length < 3) return null

  const catMap = new Map(categories.map(c => [c.id, c.name]))

  // Invalid, missing or unparseable dates are excluded from date-dependent
  // analytics instead of throwing. Those records still contribute to all-time
  // monetary metrics below, so no principal is silently discarded.
  const dateOf = new Map<Transaction, Date>()
  for (const tx of allTxns) {
    const d = getInsightsDate(tx.date)
    if (d) dateOf.set(tx, d)
  }
  const datedTxns = allTxns.filter(tx => dateOf.has(tx))
  // Windows that mean "so far" stop at the reference time, so future-dated
  // records cannot inflate current-month analytics or any other up-to-now view.
  const pastTxns = datedTxns.filter(tx => dateOf.get(tx)! <= now)

  const currentMonthKey = format(now, 'yyyy-MM')
  const lastMonthDate = subMonths(now, 1)
  const lastMonthKey = format(lastMonthDate, 'yyyy-MM')

  // Total all-time net personal spend
  const totalAllTimePaise = allTxns.reduce((s, t) => s + getNetSpendPaise(t), 0)

  // ── 1. Month Totals & Month Category Totals (Net Spend) ────────────────────
  const monthTotals = new Map<string, number>()
  const monthTxCounts = new Map<string, number>()
  const monthCatTotals = new Map<string, Map<string, number>>()

  for (const tx of pastTxns) {
    const d = dateOf.get(tx)!
    const k = format(d, 'yyyy-MM')
    const net = getNetSpendPaise(tx)

    monthTotals.set(k, (monthTotals.get(k) ?? 0) + net)
    monthTxCounts.set(k, (monthTxCounts.get(k) ?? 0) + 1)

    if (!monthCatTotals.has(k)) monthCatTotals.set(k, new Map())
    const cMap = monthCatTotals.get(k)!
    if (net > 0) {
      cMap.set(tx.categoryId, (cMap.get(tx.categoryId) ?? 0) + net)
    }
  }

  let highestSpendingMonth: InsightsSummary['highestSpendingMonth'] = null
  for (const [monthKey, totalPaise] of monthTotals) {
    if (!highestSpendingMonth || totalPaise > highestSpendingMonth.totalPaise) {
      highestSpendingMonth = { monthKey, totalPaise }
    }
  }

  // ── 2. Most Frequent & Most Expensive Category (All-Time Net Spend) ────────
  const catCount = new Map<string, number>()
  const catTotalPaise = new Map<string, number>()
  const catFirstDate = new Map<string, Date>()

  for (const tx of allTxns) {
    catCount.set(tx.categoryId, (catCount.get(tx.categoryId) ?? 0) + 1)
    const net = getNetSpendPaise(tx)
    if (net > 0) {
      catTotalPaise.set(tx.categoryId, (catTotalPaise.get(tx.categoryId) ?? 0) + net)
    }
    const d = dateOf.get(tx)
    if (d && d <= now && (!catFirstDate.has(tx.categoryId) || d < catFirstDate.get(tx.categoryId)!)) {
      catFirstDate.set(tx.categoryId, d)
    }
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

  // ── 3. Most Frequent Small Description (Net Spend <= ₹100) ─────────────────
  const smallTxns = allTxns.filter(t => {
    const net = getNetSpendPaise(t)
    return net > 0 && net <= 10_000
  })
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

  // ── 4. Largest Single Expense (Highest Personal Net Spend) ─────────────────
  let largestSingleExpense: InsightsSummary['largestSingleExpense'] = null
  for (const tx of allTxns) {
    const net = getNetSpendPaise(tx)
    if (!largestSingleExpense || net > largestSingleExpense.amountPaise) {
      largestSingleExpense = {
        id: tx.id,
        description: tx.description,
        amountPaise: net,
        date: (dateOf.has(tx) ? tx.date : null) as any,
      }
    }
  }

  // ── 5. Year-over-Year Totals (Net Spend) ───────────────────────────────────
  const yearTotals = new Map<number, number>()
  for (const tx of datedTxns) {
    const y = getYear(dateOf.get(tx)!)
    yearTotals.set(y, (yearTotals.get(y) ?? 0) + getNetSpendPaise(tx))
  }
  const yearlyTotals = [...yearTotals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, totalPaise]) => ({ year, totalPaise }))

  // ── 6. Gift & Events + Trip Totals (All-Time Net Spend) ────────────────────
  const giftEventTotalPaise = allTxns
    .filter(t => t.type === 'gift-event')
    .reduce((s, t) => s + getNetSpendPaise(t), 0)

  const tripTotalPaise = allTxns
    .filter(t => t.type === 'trip' || t.tripId != null)
    .reduce((s, t) => s + getNetSpendPaise(t), 0)

  // ── 7. Auto-Generated Sentence for Highest Year ────────────────────────────
  const highestYear = yearlyTotals.reduce<{ year: number; totalPaise: number } | null>(
    (best, y) => (!best || y.totalPaise > best.totalPaise ? y : best),
    null
  )
  let highestYearInsight = ''
  if (highestYear) {
    const txnsInYear = datedTxns.filter(t => getYear(dateOf.get(t)!) === highestYear.year)
    const specialTxns = txnsInYear.filter(t => ['one-time', 'trip', 'gift-event'].includes(t.type))
    const specialTotal = specialTxns.reduce((s, t) => s + getNetSpendPaise(t), 0)
    const specialPct = highestYear.totalPaise > 0 ? specialTotal / highestYear.totalPaise : 0

    if (specialPct > 0.3) {
      const specialCatMap = new Map<string, number>()
      for (const tx of specialTxns) {
        const net = getNetSpendPaise(tx)
        if (net > 0) {
          specialCatMap.set(tx.categoryId, (specialCatMap.get(tx.categoryId) ?? 0) + net)
        }
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
        const net = getNetSpendPaise(tx)
        if (net > 0) {
          yrCatMap.set(tx.categoryId, (yrCatMap.get(tx.categoryId) ?? 0) + net)
        }
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

  // ── 8. Last 12 Months Trend (Net Spend) ────────────────────────────────────
  const hasAnyInLast12M = Array.from({ length: 12 }, (_, idx) =>
    format(subMonths(now, idx), 'yyyy-MM')
  ).some(k => (monthTotals.get(k) ?? 0) > 0)

  const latestTxDate = pastTxns.reduce<Date | null>((latest, tx) => {
    const d = dateOf.get(tx)!
    return !latest || d > latest ? d : latest
  }, null)
  const anchorDate = hasAnyInLast12M || !latestTxDate ? now : latestTxDate

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

  // ── 9. Month-over-Month Comparison (Net Spend vs Net Spend) ────────────────
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

  // ── 10. Category Trend Over Time (Net Spend) ───────────────────────────────
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

      const firstTxForCat = catFirstDate.get(categoryId)
      const monthsSinceFirst = firstTxForCat
        ? Math.max(1, differenceInCalendarMonths(anchorDate, firstTxForCat) + 1)
        : 12
      const divisorMonths = Math.min(12, monthsSinceFirst)

      return {
        categoryId,
        name,
        total12mPaise,
        avgMonthlyPaise: Math.round(total12mPaise / divisorMonths),
        peakMonthLabel,
        peakMonthPaise,
        months,
      }
    })
    .filter(c => c.total12mPaise > 0)
    .sort((a, b) => {
      if (b.total12mPaise !== a.total12mPaise) return b.total12mPaise - a.total12mPaise
      return (catTotalPaise.get(b.categoryId) ?? 0) - (catTotalPaise.get(a.categoryId) ?? 0)
    })

  // ── 11. Day-of-Week / Spending Pattern (Net Spend) ─────────────────────────
  const dowTotals = new Map<number, number>()
  const dowTxCounts = new Map<number, number>()
  const dowCats = new Map<number, Map<string, number>>()
  const weekendCats = new Map<string, number>()

  for (const tx of pastTxns) {
    const d = dateOf.get(tx)!
    const dayIdx = d.getDay()
    const net = getNetSpendPaise(tx)

    dowTotals.set(dayIdx, (dowTotals.get(dayIdx) ?? 0) + net)
    dowTxCounts.set(dayIdx, (dowTxCounts.get(dayIdx) ?? 0) + 1)

    if (!dowCats.has(dayIdx)) dowCats.set(dayIdx, new Map())
    const dc = dowCats.get(dayIdx)!
    if (net > 0) {
      dc.set(tx.categoryId, (dc.get(tx.categoryId) ?? 0) + net)
    }

    if (dayIdx === 0 || dayIdx === 6) {
      if (net > 0) {
        weekendCats.set(tx.categoryId, (weekendCats.get(tx.categoryId) ?? 0) + net)
      }
    }
  }

  let firstTxDay = startOfDay(now)
  let lastTxDay = startOfDay(now)
  if (pastTxns.length > 0) {
    let minDate = dateOf.get(pastTxns[0])!
    let maxDate = minDate
    for (const tx of pastTxns) {
      const d = dateOf.get(tx)!
      if (d < minDate) minDate = d
      if (d > maxDate) maxDate = d
    }
    firstTxDay = startOfDay(minDate)
    lastTxDay = startOfDay(maxDate)
  }
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
  const weekdayTotalPaise = [1, 2, 3, 4, 5].reduce(
    (sum, dayIdx) => sum + (dowTotals.get(dayIdx) ?? 0),
    0
  )
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

  // ── 12. Highest Single Day of Spending Ever (Net Personal Spend) ────────────
  const dayMap = new Map<
    string,
    { totalPaise: number; txCount: number; topTx: Transaction }
  >()
  for (const tx of pastTxns) {
    const net = getNetSpendPaise(tx)
    if (net === 0) continue
    const dateStr = format(dateOf.get(tx)!, 'yyyy-MM-dd')
    const existing = dayMap.get(dateStr)
    if (!existing) {
      dayMap.set(dateStr, { totalPaise: net, txCount: 1, topTx: tx })
    } else {
      existing.totalPaise += net
      existing.txCount += 1
      if (net > getNetSpendPaise(existing.topTx)) {
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

  // ── 13. Longest Daily Logging Streak (Habit Tracker: All Logged Txns) ───────
  const loggingDates = new Set(pastTxns.map(tx => format(dateOf.get(tx)!, 'yyyy-MM-dd')))
  const sortedDates = [...loggingDates.values()].sort()
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

  // ── 14. Average Transaction Size (Net Personal Spend) ───────────────────────
  const allTimeAvgPaise = Math.round(totalAllTimePaise / allTxns.length)
  const threeMonthsAgo = subMonths(now, 3)
  const last3mTxns = pastTxns.filter(t => dateOf.get(t)! >= threeMonthsAgo)
  const last3MonthsAvgPaise =
    last3mTxns.length > 0
      ? Math.round(last3mTxns.reduce((s, t) => s + getNetSpendPaise(t), 0) / last3mTxns.length)
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

  // ── 15. Payment Mode Insight (Preserves All Payments Outflow) ───────────────
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
  const earlierPool = paymentPool.filter(t => {
    const d = dateOf.get(t)
    return d != null && d < sixMonthsAgo
  })
  const recentPool = paymentPool.filter(t => {
    const d = dateOf.get(t)
    return d != null && d >= sixMonthsAgo && d <= now
  })

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

  // ── 16. Synthesized Insight Sentences ──────────────────────────────────────
  const insightSentences = [
    momSummarySentence,
    highestYearInsight,
    patternSentence,
  ].filter(Boolean)

  return {
    computedAt: { seconds: Math.floor(now.getTime() / 1000), nanoseconds: 0 } as any,
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
}

/**
 * Calculates current month spending pace, daily burn rate, and month-end projection.
 */
export function calculateSpendingPace(
  netSpendPaise: number,
  now: Date = new Date()
): {
  dailyPacePaise: number
  projectedMonthEndPaise: number | null
  daysElapsed: number
  daysInMonth: number
  hasEnoughDaysForPace: boolean
} {
  const daysInMonth = getDaysInMonth(now)
  const daysElapsed = Math.max(1, now.getDate())
  const hasEnoughDaysForPace = daysElapsed >= 3

  const dailyPacePaise = Math.round(netSpendPaise / daysElapsed)
  const projectedMonthEndPaise = hasEnoughDaysForPace
    ? Math.round(dailyPacePaise * daysInMonth)
    : null

  return {
    dailyPacePaise,
    projectedMonthEndPaise,
    daysElapsed,
    daysInMonth,
    hasEnoughDaysForPace,
  }
}
