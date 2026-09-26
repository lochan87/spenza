import {
  collection, query, where, getDocs, Timestamp,
} from 'firebase/firestore'
import {
  startOfMonth, endOfMonth, subMonths, format,
} from 'date-fns'
import { db } from '@/firebase/config'
import type { Transaction, PaymentAccount, Category } from '@/types'

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
  /** Spend by payment mode this month */
  paymentModeTotals: PaymentModeTotal[]
  /** Spend by specific account (UPI/Card/Bank only) this month */
  accountTotals: AccountTotal[]

  // Derived scalars
  thisMonthTotal: number
  lastMonthTotal: number
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

  /** Micro transactions (≤ ₹100) */
  microCount: number
  microTotal: number
  microAvg: number
}

// ─── Fetch raw transactions ───────────────────────────────────────────────────

/**
 * DATA STRATEGY:
 * Fetch all transactions from 6 months ago to today in a single Firestore query.
 * This is correct and efficient for a single-user app with modest volume (hundreds/month).
 * All 8 dashboard sections are derived client-side from this one dataset.
 * We avoid monthly rollup documents because they'd require updating on every transaction
 * write/edit/delete — adding complexity for no meaningful perf gain at this scale.
 */
export async function fetchDashboardTransactions(
  uid: string
): Promise<Transaction[]> {
  const now = new Date()
  const sixMonthsAgo = startOfMonth(subMonths(now, 5))

  const ref = collection(db, 'users', uid, 'transactions')
  const q = query(
    ref,
    where('date', '>=', Timestamp.fromDate(sixMonthsAgo)),
    where('date', '<=', Timestamp.fromDate(now))
  )

  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction)
}

// ─── Derive dashboard data ────────────────────────────────────────────────────

export function deriveDashboardData(
  allTxns: Transaction[],
  categories: Category[],
  accounts: PaymentAccount[]
): DashboardData {
  const now = new Date()
  const monthStart = startOfMonth(now)
  const monthEnd = endOfMonth(now)
  const lastMonthStart = startOfMonth(subMonths(now, 1))
  const lastMonthEnd = endOfMonth(subMonths(now, 1))

  const toDate = (ts: any): Date => {
    if (ts?.toDate) return ts.toDate()
    if (ts instanceof Date) return ts
    return new Date(ts)
  }

  const isInRange = (ts: any, start: Date, end: Date) => {
    const d = toDate(ts)
    return d >= start && d <= end
  }

  // Split by month
  const thisMonthTxns = allTxns.filter(tx => isInRange(tx.date, monthStart, monthEnd))
  const lastMonthTxns = allTxns.filter(tx => isInRange(tx.date, lastMonthStart, lastMonthEnd))

  // ── Scalars ──────────────────────────────────────────────────────────────────
  const thisMonthTotal = thisMonthTxns.reduce((s, t) => s + t.amountPaise, 0)
  const lastMonthTotal = lastMonthTxns.reduce((s, t) => s + t.amountPaise, 0)
  const pctChange = lastMonthTotal === 0
    ? null
    : ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100

  const txnCount = thisMonthTxns.length
  const dayOfMonth = now.getDate()
  const avgPerDay = dayOfMonth > 0 ? thisMonthTotal / dayOfMonth : 0

  // ── Type breakdown ────────────────────────────────────────────────────────────
  const sumType = (type: string) =>
    thisMonthTxns.filter(t => t.type === type).reduce((s, t) => s + t.amountPaise, 0)

  const everydayTotal = sumType('everyday')
  const recurringTotal = sumType('recurring')
  const oneTimeTotal = sumType('one-time')
  const tripTotal = sumType('trip')
  const giftEventTotal = sumType('gift-event')
  const reimbursableTotal = sumType('reimbursable')
  // "Normal spend" = everyday + recurring ONLY
  const normalSpendTotal = everydayTotal + recurringTotal

  // ── Top categories ────────────────────────────────────────────────────────────
  const catMap = new Map<string, number>()
  for (const tx of thisMonthTxns) {
    catMap.set(tx.categoryId, (catMap.get(tx.categoryId) ?? 0) + tx.amountPaise)
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

  // ── Biggest expenses ──────────────────────────────────────────────────────────
  const biggestExpenses = [...thisMonthTxns]
    .sort((a, b) => b.amountPaise - a.amountPaise)
    .slice(0, 5)

  // ── Micro transactions (≤ ₹100 = ≤ 10000 paise) ──────────────────────────────
  const microTxns = thisMonthTxns.filter(t => t.amountPaise <= 10_000)
  const microCount = microTxns.length
  const microTotal = microTxns.reduce((s, t) => s + t.amountPaise, 0)
  const microAvg = microCount > 0 ? microTotal / microCount : 0

  // ── Payment mode breakdown ────────────────────────────────────────────────────
  const modeMap = new Map<string, number>()
  for (const tx of thisMonthTxns) {
    modeMap.set(tx.paymentMode, (modeMap.get(tx.paymentMode) ?? 0) + tx.amountPaise)
  }
  const paymentModeTotals: PaymentModeTotal[] = [...modeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([mode, totalPaise]) => ({ mode, totalPaise }))

  // ── Account breakdown (UPI/Bank Transfer/Card ONLY, per spec) ─────────────────
  const ACCOUNT_MODES = new Set(['UPI', 'Bank Transfer', 'Card'])
  const accMap = new Map<string, number>()
  for (const tx of thisMonthTxns) {
    if (!ACCOUNT_MODES.has(tx.paymentMode) || !tx.paymentAccountId) continue
    accMap.set(tx.paymentAccountId, (accMap.get(tx.paymentAccountId) ?? 0) + tx.amountPaise)
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

  // ── 6-month trend ─────────────────────────────────────────────────────────────
  const monthTotalsRaw = new Map<string, number>()
  // Pre-populate all 6 months with 0 (so months with no spend still appear)
  for (let i = 5; i >= 0; i--) {
    const d = subMonths(now, i)
    const key = format(d, 'yyyy-MM')
    monthTotalsRaw.set(key, 0)
  }
  for (const tx of allTxns) {
    const d = toDate(tx.date)
    const key = format(d, 'yyyy-MM')
    if (monthTotalsRaw.has(key)) {
      monthTotalsRaw.set(key, (monthTotalsRaw.get(key) ?? 0) + tx.amountPaise)
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
    microCount,
    microTotal,
    microAvg,
  }
}
