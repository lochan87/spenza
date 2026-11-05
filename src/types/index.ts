import type { Timestamp } from 'firebase/firestore'

// ─── Payment Mode ─────────────────────────────────────────────────────────────

export type PaymentMode = 'Cash' | 'UPI' | 'Bank Transfer' | 'Card' | 'Other'

/** Payment modes that REQUIRE a linked paymentAccountId */
export const ACCOUNT_REQUIRED_MODES: PaymentMode[] = ['UPI', 'Bank Transfer', 'Card']

/** Payment modes that MUST have paymentAccountId = null */
export const ACCOUNT_NULL_MODES: PaymentMode[] = ['Cash', 'Other']

// ─── Transaction ─────────────────────────────────────────────────────────────

export type TransactionType =
  | 'everyday'
  | 'recurring'
  | 'one-time'
  | 'trip'
  | 'gift-event'
  | 'reimbursable'

export type ReimbursementStatus = 'none' | 'pending' | 'partial' | 'settled'

/** Per-person recoverable share embedded in a Transaction document */
export interface SplitShare {
  /** References users/{uid}/people/{id}, or '__unassigned__' for legacy/unnamed reimbursable items */
  personId: string
  /** Denormalized display name so rows render without extra reads and survive person archival */
  personName: string
  /** Integer paise fronted for this person (their share of the bill). Must be > 0. */
  amountPaise: number
  /** Integer paise repaid by this person so far. Always satisfies: 0 <= repaidPaise <= amountPaise */
  repaidPaise: number
  /** Timestamp of most recent repayment/settlement, or null if unpaid */
  settledAt?: Timestamp | null
}

/** Core transaction document stored in users/{uid}/transactions/{id} */
export interface Transaction {
  id: string
  /** Amount in paise (integer). Never store float rupees. 1 rupee = 100 paise */
  amountPaise: number
  description: string
  categoryId: string
  type: TransactionType
  date: Timestamp

  // ── Payment mode + account ──────────────────────────────────────────────
  paymentMode: PaymentMode
  /**
   * Required (non-null) when paymentMode is "UPI", "Bank Transfer", or "Card".
   * Must be null when paymentMode is "Cash" or "Other".
   * References a document in paymentAccounts/{accountId}.
   */
  paymentAccountId: string | null

  // ── Optional relations ──────────────────────────────────────────────────
  tripId: string | null
  personId: string | null
  tags: string[]
  notes: string
  receiptUrl: string | null // reserved for Phase 2 image upload

  // ── Recoverables & Splits (optional for backward compatibility) ─────────
  /**
   * Portion of amountPaise (in integer paise) fronted on behalf of other people.
   * Net personal spending is amountPaise - recoverablePaise.
   * Always satisfies: 0 <= recoverablePaise <= amountPaise.
   */
  recoverablePaise?: number
  /** Per-person breakdown of recoverablePaise and their repayment progress. */
  splits?: SplitShare[]
  /** Summary status derived from splits / recoverablePaise. */
  reimbursementStatus?: ReimbursementStatus

  // ── Import provenance ───────────────────────────────────────────────────
  /** True for rows bulk-imported from Excel. paymentMode will be 'Other' and paymentAccountId null. */
  isImported?: boolean
  /** 'excel' for SheetJS-imported rows. Undefined for manually entered transactions. */
  importSource?: 'excel' | null

  createdAt: Timestamp
  updatedAt: Timestamp
}

/** Convenience: amount as display rupees (divide paise by 100) */
export function paiseToRupees(paise: number): number {
  return paise / 100
}

/** Convenience: rupees as integer paise (multiply by 100, round) */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100)
}

// ─── Payment Account ─────────────────────────────────────────────────────────

export type AccountType = 'Bank' | 'UPI' | 'Card' | 'Wallet'

/** Stored in users/{uid}/paymentAccounts/{id} */
export interface PaymentAccount {
  id: string
  name: string            // e.g. "HDFC Bank", "Google Pay UPI"
  type: AccountType
  isDefault: boolean      // shown first in quick-pick
  isArchived: boolean     // soft-delete so historical references stay valid
  createdAt: Timestamp
}

// ─── Category ────────────────────────────────────────────────────────────────

/** Stored in users/{uid}/categories/{id} */
export interface Category {
  id: string
  name: string
  icon: string    // Lucide icon name or emoji
  color: string   // hex color for UI display
  isArchived: boolean
}

// ─── Budget ──────────────────────────────────────────────────────────────────

/** Stored in users/{uid}/budgets/{YYYY-MM} */
export interface Budget {
  id: string              // format: "YYYY-MM"
  totalBudgetPaise: number | null
  categoryBudgets: Record<string, number>  // categoryId → paise
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ─── Trip ────────────────────────────────────────────────────────────────────

/** Stored in users/{uid}/trips/{id} */
export interface Trip {
  id: string
  name: string
  startDate: Timestamp
  endDate: Timestamp | null
  coverEmoji: string          // e.g. "✈️"
  coverColor: string          // hex accent for this trip card
  budgetPaise: number | null  // optional trip budget
  isArchived: boolean
  notes: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ─── Recurring ────────────────────────────────────────────────────────────────

export type RecurringFrequency = 'weekly' | 'monthly' | 'yearly'

/** Stored in users/{uid}/recurring/{id} */
export interface RecurringItem {
  id: string
  description: string
  amountPaise: number
  categoryId: string
  frequency: RecurringFrequency
  /** 1–28 for monthly */
  dayOfMonth: number | null
  /** 0=Sun…6=Sat for weekly */
  dayOfWeek: number | null
  /** "MM-DD" for yearly */
  monthDay: string | null
  nextDueDate: Timestamp
  lastGeneratedDate: Timestamp | null
  paymentMode: PaymentMode
  paymentAccountId: string | null
  isActive: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ─── Insights ─────────────────────────────────────────────────────────────────

export interface MonthlyTrendPoint {
  monthKey: string            // "YYYY-MM"
  label: string               // e.g. "Nov '25"
  fullLabel: string           // e.g. "November 2025"
  totalPaise: number
  txCount: number
  pctChangeVsPrev: number | null
  topCategoryName: string | null
  topCategoryPaise: number
  isCurrentMonth: boolean
  isOutlier: boolean          // >50% above 12-month non-zero average
}

export interface CategoryShiftItem {
  categoryId: string
  name: string
  thisMonthPaise: number
  lastMonthPaise: number
  diffPaise: number           // thisMonth - lastMonth
  pctChange: number | null    // null if lastMonth was 0
}

export interface MonthOverMonthComparison {
  thisMonthKey: string
  lastMonthKey: string
  thisMonthLabel: string
  lastMonthLabel: string
  thisMonthPaise: number
  lastMonthPaise: number
  diffPaise: number
  pctChange: number | null
  thisMonthTxCount: number
  lastMonthTxCount: number
  biggestIncrease: CategoryShiftItem | null
  biggestDecrease: CategoryShiftItem | null
  summarySentence: string
}

export interface CategoryMonthlyTrend {
  categoryId: string
  name: string
  total12mPaise: number
  avgMonthlyPaise: number
  peakMonthLabel: string | null
  peakMonthPaise: number
  months: Array<{
    monthKey: string
    label: string
    totalPaise: number
    isCurrentMonth: boolean
  }>
}

export interface DayOfWeekItem {
  dayIndex: number            // 0=Sun..6=Sat
  shortName: string           // "Mon", "Tue", ...
  fullName: string            // "Monday", ...
  totalPaise: number
  txCount: number
  avgPerOccurrencePaise: number
  topCategoryName: string | null
  isWeekend: boolean
}

export interface DayOfWeekStats {
  days: DayOfWeekItem[]       // Ordered Mon (1) -> Sun (0)
  peakDayName: string
  peakDayAvgPaise: number
  peakDayTopCategory: string | null
  weekendDailyAvgPaise: number
  weekdayDailyAvgPaise: number
  weekendVsWeekdayPct: number | null // e.g. +40 means weekends are 40% higher per day
  topWeekendCategories: string[]
  patternSentence: string
}

export interface HighestSpendingDay {
  dateStr: string             // "YYYY-MM-DD"
  totalPaise: number
  txCount: number
  topDescription: string
  topCategoryName: string
}

export interface LoggingStreakInfo {
  longestDays: number
  longestStartDate: string | null // "YYYY-MM-DD"
  longestEndDate: string | null   // "YYYY-MM-DD"
  currentDays: number
}

export interface AvgTransactionSizeInfo {
  allTimeAvgPaise: number
  last3MonthsAvgPaise: number | null
  pctDiff: number | null      // positive = creeping up
}

export interface MostExpensiveCategoryInfo {
  categoryId: string
  name: string
  totalPaise: number
  sharePct: number
}

export interface PaymentModeInsightInfo {
  dominantMode: PaymentMode
  dominantSharePct: number
  dominantCount: number
  recentMode: PaymentMode | null
  earlierMode: PaymentMode | null
  shifted: boolean
  summaryText: string
}

/** Cached at users/{uid}/insights/summary — recomputed on-demand */
export interface InsightsSummary {
  computedAt: Timestamp
  /** Schema version of the cached summary document */
  schemaVersion?: number
  /** Calendar month ("YYYY-MM") when this summary was computed */
  computedMonthKey?: string
  /** Total number of transactions when this summary was computed */
  transactionCount?: number
  highestSpendingMonth: { monthKey: string; totalPaise: number } | null
  mostFrequentCategory: { categoryId: string; name: string; count: number } | null
  mostFrequentSmallDesc: { description: string; count: number } | null
  largestSingleExpense: {
    id: string; description: string; amountPaise: number; date: Timestamp
  } | null
  /** Sorted ascending by year */
  yearlyTotals: Array<{ year: number; totalPaise: number }>
  giftEventTotalPaise: number
  tripTotalPaise: number
  /** Auto-generated explanatory sentence for the highest-spend year */
  highestYearInsight: string

  // ── Extended Insights (Phase 6+) ────────────────────────────────────────
  /** Last 12 calendar months of spending */
  monthlyTrend?: MonthlyTrendPoint[]
  /** Detailed comparison between current month and previous month */
  monthComparison?: MonthOverMonthComparison
  /** 12-month spending series per category, sorted by 12m total desc */
  categoryMonthlyTrends?: CategoryMonthlyTrend[]
  /** Day-of-week distribution and weekday vs weekend analysis */
  dayOfWeekStats?: DayOfWeekStats
  /** Highest single calendar day of spending ever */
  highestSpendingDay?: HighestSpendingDay | null
  /** Daily expense logging streak metrics */
  longestStreak?: LoggingStreakInfo
  /** Average transaction size: all-time vs last 3 months */
  avgTransactionSize?: AvgTransactionSizeInfo
  /** Highest-spend category by all-time rupee volume */
  mostExpensiveCategory?: MostExpensiveCategoryInfo | null
  /** Dominant payment mode and 6-month shift detection */
  paymentModeInsight?: PaymentModeInsightInfo | null
  /** 2-3 synthesized insight sentences across year, month, and pattern levels */
  insightSentences?: string[]
}

// ─── Person ──────────────────────────────────────────────────────────────────

/** Stored in users/{uid}/people/{id} — for split/reimbursable tracking */
export interface Person {
  id: string
  name: string
  isArchived?: boolean
  createdAt: Timestamp
}

// ─── Profile ─────────────────────────────────────────────────────────────────

/** Stored in users/{uid}/profile (single document, not a subcollection) */
export interface UserProfile {
  uid: string
  displayName: string | null
  email: string | null
  photoURL: string | null
  defaultPaymentAccountId: string | null
  onboardingComplete: boolean
  peopleOnboardingCompleted?: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
}

