import {
  collection, getDocs,
} from 'firebase/firestore'
import {
  startOfMonth, endOfMonth, subMonths, format,
} from 'date-fns'
import type { Transaction, PaymentAccount, Category } from '../../types/index.ts'
import {
  getNetSpendPaise,
  getRecoverablePaise,
  getRepaidPaise,
  getPendingRecoverablePaise,
  toNonNegativeIntPaise,
  aggregatePeopleDues,
  type PersonDuesSummary,
} from '../../utils/splitMath.ts'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MonthlyTotal {
  /** "Jan", "Feb" etc. */
  monthLabel: string
  /** Full "2026-01" for sorting */
  monthKey: string
  totalPaise: number
  /** True if this month is > 1.5× the 6-month average */
  isOutlier: boolean
}

export interface CategoryTotal {
  categoryId: string
  name: string
  totalPaise: number
}

export interface PaymentModeTotal {
  mode: string
  totalPaise: number
}

export interface AccountTotal {
  accountId: string
  accountName: string
  accountType: string
  totalPaise: number
}

export interface DashboardData {
  /** All txns in current month */
  thisMonthTxns: Transaction[]
  /** All txns in last month */
  lastMonthTxns: Transaction[]
  /** Aggregated monthly totals for the last 6 months (oldest → newest) */
  monthlyTotals: MonthlyTotal[]
  /** Top 5 categories by spend this month */
  topCategories: CategoryTotal[]
  /** Top 5 single transactions by amount this month */
  biggestExpenses: Transaction[]
  /** Spend by payment mode this month (gross outflow) */
  paymentModeTotals: PaymentModeTotal[]
  /** Spend by specific account (UPI/Card/Bank only) this month (gross outflow) */
  accountTotals: AccountTotal[]

  // Derived scalars
  thisMonthTotal: number
  lastMonthTotal: number
  thisMonthGrossOutflow: number
  /** pct change relative to last month (null if last month = 0) */
  pctChange: number | null
  txnCount: number
  /** avg per day based on days elapsed so far this month */
  avgPerDay: number
  topCategoryName: string
  topCategoryId: string

  /** Everyday + recurring only (excludes one-time, trip, gift-event) */
  normalSpendTotal: number
  everydayTotal: number
  recurringTotal: number
  oneTimeTotal: number
  tripTotal: number
  giftEventTotal: number
  reimbursableTotal: number

  // Recoverables & pending dues
  thisMonthRecoverableTotal: number
  thisMonthRepaidTotal: number
  thisMonthPendingDuesTotal: number
  allTimeRecoverableTotal: number
  allTimeRepaidTotal: number
  allTimePendingDuesTotal: number
  peopleDues: PersonDuesSummary[]

  /** Micro transactions (≤ ₹100) */
  microCount: number
  microTotal: number
  microAvg: number
}

// ─── Fetch raw transactions ───────────────────────────────────────────────────

/**
 * DATA STRATEGY:
 * Fetch the owner's complete transaction history, including future-dated records,
 * so all-time recoverables and people dues agree with Friends.
 * Recent-period analytics filter this dataset client-side. Read cost grows with
 * history size; all dashboard sections share this one fetch.
 */
export async function fetchDashboardTransactions(
  uid: string
): Promise<Transaction[]> {
  const { db } = await import('../../firebase/config.ts')
  const ref = collection(db, 'users', uid, 'transactions')
  const snap = await getDocs(ref)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction)
}

// ─── Derive dashboard data ────────────────────────────────────────────────────

export function deriveDashboardData(
  allTxns: Transaction[],
  categories: Category[],
  accounts: PaymentAccount[],
  now: Date = new Date()
): DashboardData {
  const monthStart = startOfMonth(now)
  const lastMonthStart = startOfMonth(subMonths(now, 1))
  const lastMonthEnd = endOfMonth(subMonths(now, 1))

  const toDate = (ts: any): Date | null => {
    if (ts == null) return null
    const date = typeof ts?.toDate === 'function'
      ? ts.toDate()
      : ts instanceof Date ? ts : new Date(ts)
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null
  }

  const isInRange = (ts: any, start: Date, end: Date) => {
    const d = toDate(ts)
    return d !== null && d >= start && d <= end
  }

  // Current-month analytics stop at `now`; all-time dues still use complete history.
  const thisMonthTxns = allTxns.filter(tx => isInRange(tx.date, monthStart, now))
  const lastMonthTxns = allTxns.filter(tx => isInRange(tx.date, lastMonthStart, lastMonthEnd))

  // ── Scalars (Net personal spend) ──────────────────────────────────────────────
  const thisMonthTotal = thisMonthTxns.reduce((s, t) => s + getNetSpendPaise(t), 0)
  const lastMonthTotal = lastMonthTxns.reduce((s, t) => s + getNetSpendPaise(t), 0)
  const thisMonthGrossOutflow = thisMonthTxns.reduce((s, t) => s + toNonNegativeIntPaise(t.amountPaise), 0)

  const pctChange = lastMonthTotal === 0
    ? null
    : ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100

  const txnCount = thisMonthTxns.length
  const dayOfMonth = now.getDate()
  const avgPerDay = dayOfMonth > 0 ? thisMonthTotal / dayOfMonth : 0

  // ── Recoverables & Pending Dues ──────────────────────────────────────────────
  const thisMonthRecoverableTotal = thisMonthTxns.reduce((s, t) => s + getRecoverablePaise(t), 0)
  const thisMonthRepaidTotal = thisMonthTxns.reduce((s, t) => s + getRepaidPaise(t), 0)
  const thisMonthPendingDuesTotal = thisMonthTxns.reduce((s, t) => s + getPendingRecoverablePaise(t), 0)

  const allTimeRecoverableTotal = allTxns.reduce((s, t) => s + getRecoverablePaise(t), 0)
  const allTimeRepaidTotal = allTxns.reduce((s, t) => s + getRepaidPaise(t), 0)
  const allTimePendingDuesTotal = allTxns.reduce((s, t) => s + getPendingRecoverablePaise(t), 0)
  const peopleDues = aggregatePeopleDues(allTxns)

  // ── Type breakdown (Net personal spend) ───────────────────────────────────────
  const sumType = (type: string) =>
    thisMonthTxns.filter(t => t.type === type).reduce((s, t) => s + getNetSpendPaise(t), 0)

  const everydayTotal = sumType('everyday')
  const recurringTotal = sumType('recurring')
  const oneTimeTotal = sumType('one-time')
  const tripTotal = sumType('trip')
  const giftEventTotal = sumType('gift-event')
  const reimbursableTotal = sumType('reimbursable')
  // "Normal spend" = everyday + recurring ONLY
  const normalSpendTotal = everydayTotal + recurringTotal

  // ── Top categories (Net personal spend) ───────────────────────────────────────
  const catMap = new Map<string, number>()
  for (const tx of thisMonthTxns) {
    const net = getNetSpendPaise(tx)
    if (net > 0) {
      catMap.set(tx.categoryId, (catMap.get(tx.categoryId) ?? 0) + net)
    }
  }
  const topCategories: CategoryTotal[] = [...catMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([categoryId, totalPaise]) => {
      const cat = categories.find(c => c.id === categoryId)
      return { categoryId, name: cat?.name ?? 'Other', totalPaise }
    })

  const topCat = topCategories[0]
  const topCategoryId = topCat?.categoryId ?? ''
  const topCategoryName = topCat?.name ?? '—'

  // ── Biggest expenses (Sorted by net personal spend, then gross amount) ────────
  const biggestExpenses = [...thisMonthTxns]
    .sort((a, b) => {
      const netB = getNetSpendPaise(b)
      const netA = getNetSpendPaise(a)
      if (netB !== netA) return netB - netA
      return toNonNegativeIntPaise(b.amountPaise) - toNonNegativeIntPaise(a.amountPaise)
    })
    .slice(0, 5)

  // ── Micro transactions (≤ ₹100 = ≤ 10000 paise net personal spend) ────────────
  const microTxns = thisMonthTxns.filter(t => {
    const net = getNetSpendPaise(t)
    return net > 0 && net <= 10_000
  })
  const microCount = microTxns.length
  const microTotal = microTxns.reduce((s, t) => s + getNetSpendPaise(t), 0)
  const microAvg = microCount > 0 ? microTotal / microCount : 0

  // ── Payment mode breakdown (GROSS OUTFLOW: reflects actual money leaving wallets/accounts) ──
  const modeMap = new Map<string, number>()
  for (const tx of thisMonthTxns) {
    const gross = toNonNegativeIntPaise(tx.amountPaise)
    modeMap.set(tx.paymentMode, (modeMap.get(tx.paymentMode) ?? 0) + gross)
  }
  const paymentModeTotals: PaymentModeTotal[] = [...modeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([mode, totalPaise]) => ({ mode, totalPaise }))

  // ── Account breakdown (GROSS OUTFLOW: UPI/Bank Transfer/Card ONLY, per spec) ──
  const ACCOUNT_MODES = new Set(['UPI', 'Bank Transfer', 'Card'])
  const accMap = new Map<string, number>()
  for (const tx of thisMonthTxns) {
    if (!ACCOUNT_MODES.has(tx.paymentMode) || !tx.paymentAccountId) continue
    const gross = toNonNegativeIntPaise(tx.amountPaise)
    accMap.set(tx.paymentAccountId, (accMap.get(tx.paymentAccountId) ?? 0) + gross)
  }
  const accountTotals: AccountTotal[] = [...accMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([accountId, totalPaise]) => {
      const acc = accounts.find(a => a.id === accountId)
      return {
        accountId,
        accountName: acc?.name ?? 'Unknown',
        accountType: acc?.type ?? 'Bank',
        totalPaise,
      }
    })

  // ── 6-month trend (Net personal spend) ─────────────────────────────────────────
  const monthTotalsRaw = new Map<string, number>()
  // Pre-populate all 6 months with 0 (so months with no spend still appear)
  for (let i = 5; i >= 0; i--) {
    const d = subMonths(now, i)
    const key = format(d, 'yyyy-MM')
    monthTotalsRaw.set(key, 0)
  }
  for (const tx of allTxns) {
    const d = toDate(tx.date)
    if (d === null || d > now) continue
    const key = format(d, 'yyyy-MM')
    if (monthTotalsRaw.has(key)) {
      monthTotalsRaw.set(key, (monthTotalsRaw.get(key) ?? 0) + getNetSpendPaise(tx))
    }
  }

  const monthEntries = [...monthTotalsRaw.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))

  const avg6 = monthEntries.reduce((s, [, v]) => s + v, 0) / monthEntries.length
  const OUTLIER_THRESHOLD = 1.5

  const monthlyTotals: MonthlyTotal[] = monthEntries.map(([key, totalPaise]) => ({
    monthKey: key,
    monthLabel: format(new Date(key + '-01'), 'MMM'),
    totalPaise,
    isOutlier: avg6 > 0 && totalPaise > avg6 * OUTLIER_THRESHOLD,
  }))

  return {
    thisMonthTxns,
    lastMonthTxns,
    monthlyTotals,
    topCategories,
    biggestExpenses,
    paymentModeTotals,
    accountTotals,
    thisMonthTotal,
    lastMonthTotal,
    thisMonthGrossOutflow,
    pctChange,
    txnCount,
    avgPerDay,
    topCategoryName,
    topCategoryId,
    normalSpendTotal,
    everydayTotal,
    recurringTotal,
    oneTimeTotal,
    tripTotal,
    giftEventTotal,
    reimbursableTotal,
    thisMonthRecoverableTotal,
    thisMonthRepaidTotal,
    thisMonthPendingDuesTotal,
    allTimeRecoverableTotal,
    allTimeRepaidTotal,
    allTimePendingDuesTotal,
    peopleDues,
    microCount,
    microTotal,
    microAvg,
  }
}
