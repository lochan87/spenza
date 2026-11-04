import { differenceInDays, eachDayOfInterval, format } from 'date-fns'
import type { Category, Transaction, Trip } from '../types/index.ts'
import {
  getNetSpendPaise,
  getRecoverablePaise,
  getRepaidPaise,
  getPendingRecoverablePaise,
  toNonNegativeIntPaise,
} from './splitMath.ts'

/**
 * Trip sub-category buckets — used only within trip breakdowns.
 * These 5 buckets are separate from the main category color palette.
 * Per spec: Transport #3B82F6, Food #F59E0B, Stay #8B5CF6,
 *           Activities #14B8A6, Misc #64748B
 */

export type TripBucket = 'Transport' | 'Food' | 'Stay' | 'Activities' | 'Misc'

export const TRIP_ACCENT_COLOR = '#06B6D4'  // cyan-500, primary accent for trips

export const TRIP_BUCKET_META: Record<TripBucket, { color: string; emoji: string; bg: string }> = {
  Transport:  { color: '#3B82F6', emoji: '🚗', bg: 'rgba(59, 130, 246, 0.12)' },
  Food:       { color: '#F59E0B', emoji: '🍽️', bg: 'rgba(245, 158, 11, 0.12)' },
  Stay:       { color: '#8B5CF6', emoji: '🏨', bg: 'rgba(139, 92, 246, 0.12)' },
  Activities: { color: '#14B8A6', emoji: '🎡', bg: 'rgba(20, 184, 166, 0.12)' },
  Misc:       { color: '#64748B', emoji: '📦', bg: 'rgba(100, 116, 139, 0.12)' },
}

const TRANSPORT_KW  = ['transport', 'vehicle', 'travel', 'auto', 'cab', 'taxi', 'bus', 'train', 'flight', 'metro', 'fuel', 'petrol', 'uber', 'ola', 'rapido', 'rickshaw', 'ferry', 'toll']
const FOOD_KW       = ['food', 'drink', 'restaurant', 'cafe', 'coffee', 'dining', 'eat', 'meal', 'snack', 'breakfast', 'lunch', 'dinner', 'zomato', 'swiggy', 'blinkit', 'grocery']
const STAY_KW       = ['stay', 'hotel', 'accommodation', 'hostel', 'airbnb', 'lodge', 'pg', 'oyo', 'resort', 'guesthouse', 'homestay']
const ACTIVITIES_KW = ['entertainment', 'outing', 'outings', 'social', 'meetup', 'hangout', 'sport', 'cinema', 'movie', 'park', 'museum', 'event', 'show', 'gym', 'activity', 'experience', 'tour', 'adventure', 'trek', 'hike', 'shopping', 'souvenir']

/**
 * Map a main category name to one of the 5 trip buckets.
 * Called per-transaction when computing trip detail breakdown.
 */
export function mapCategoryToTripBucket(categoryName: string): TripBucket {
  const n = categoryName.toLowerCase()
  if (TRANSPORT_KW.some(k => n.includes(k)))  return 'Transport'
  if (FOOD_KW.some(k => n.includes(k)))        return 'Food'
  if (STAY_KW.some(k => n.includes(k)))        return 'Stay'
  if (ACTIVITIES_KW.some(k => n.includes(k)))  return 'Activities'
  return 'Misc'
}

/** Budget vs actual color rule — applies to both trip and category budgets */
export function getBudgetColor(pct: number): string {
  if (pct >= 100) return 'var(--danger)'
  if (pct >= 90)  return '#F97316'   // orange-500 — between warning and danger
  if (pct >= 70)  return 'var(--warning)'
  return 'var(--success)'
}

export function getBudgetBg(pct: number): string {
  if (pct >= 100) return 'var(--danger-muted)'
  if (pct >= 90)  return 'rgba(249, 115, 22, 0.1)'
  if (pct >= 70)  return 'var(--warning-muted)'
  return 'var(--success-muted)'
}

export interface TripDayTotal {
  label: string
  dateStr: string
  totalPaise: number
}

export interface TripAccountingSummary {
  totalNetSpendPaise: number
  totalGrossOutflowPaise: number
  recoverablePaise: number
  repaidPaise: number
  pendingPaise: number
  days: number
  avgPerDayPaise: number
  budgetPct: number | null
  isOverBudget: boolean
  bucketTotals: Map<TripBucket, number>
}

/**
 * Calculates net personal spend across trip transactions.
 */
export function calculateTripNetSpend(transactions: Transaction[]): number {
  return transactions.reduce((sum, tx) => sum + getNetSpendPaise(tx), 0)
}

/**
 * Calculates gross outflow (actual money paid out) across trip transactions.
 */
export function calculateTripGrossOutflow(transactions: Transaction[]): number {
  return transactions.reduce((sum, tx) => sum + toNonNegativeIntPaise(tx.amountPaise), 0)
}

/**
 * Calculates recoverable amounts, repaid amounts, and outstanding dues for a trip.
 */
export function calculateTripRecoverables(transactions: Transaction[]): {
  recoverablePaise: number
  repaidPaise: number
  pendingPaise: number
} {
  return {
    recoverablePaise: transactions.reduce((s, t) => s + getRecoverablePaise(t), 0),
    repaidPaise: transactions.reduce((s, t) => s + getRepaidPaise(t), 0),
    pendingPaise: transactions.reduce((s, t) => s + getPendingRecoverablePaise(t), 0),
  }
}

/**
 * Computes net personal spend across the 5 trip buckets.
 */
export function calculateTripBucketTotals(
  transactions: Transaction[],
  categories: Category[]
): Map<TripBucket, number> {
  const catMap = new Map(categories.map(c => [c.id, c.name]))
  const bucketMap = new Map<TripBucket, number>()
  for (const tx of transactions) {
    const net = getNetSpendPaise(tx)
    if (net <= 0) continue
    const catName = catMap.get(tx.categoryId) ?? 'Other'
    const bucket = mapCategoryToTripBucket(catName)
    bucketMap.set(bucket, (bucketMap.get(bucket) ?? 0) + net)
  }
  return bucketMap
}

/**
 * Computes day-by-day net personal spend across the trip date interval.
 */
export function calculateTripDayTotals(
  transactions: Transaction[],
  startDate: Date,
  endDate: Date
): TripDayTotal[] {
  const toDate = (ts: any): Date => (ts?.toDate ? ts.toDate() : new Date(ts))
  const interval = eachDayOfInterval({ start: startDate, end: endDate })

  return interval.map((d, i) => {
    const dStr = format(d, 'yyyy-MM-dd')
    const dayTotal = transactions
      .filter(tx => format(toDate(tx.date), 'yyyy-MM-dd') === dStr)
      .reduce((s, t) => s + getNetSpendPaise(t), 0)
    return { label: `D${i + 1}`, dateStr: dStr, totalPaise: dayTotal }
  })
}

/**
 * Derives comprehensive trip accounting, net spend, gross outflow, recoverables, and budget tracking.
 */
export function calculateTripAccountingSummary(
  trip: Trip,
  transactions: Transaction[],
  categories: Category[]
): TripAccountingSummary {
  const toDate = (ts: any): Date => (ts?.toDate ? ts.toDate() : new Date(ts))
  const start = toDate(trip.startDate)
  const end = trip.endDate ? toDate(trip.endDate) : new Date()
  const days = Math.max(1, differenceInDays(end, start) + 1)

  const totalNetSpendPaise = calculateTripNetSpend(transactions)
  const totalGrossOutflowPaise = calculateTripGrossOutflow(transactions)
  const { recoverablePaise, repaidPaise, pendingPaise } = calculateTripRecoverables(transactions)

  const avgPerDayPaise = Math.round(totalNetSpendPaise / days)
  const budgetPct = trip.budgetPaise ? (totalNetSpendPaise / trip.budgetPaise) * 100 : null
  const isOverBudget = trip.budgetPaise != null ? totalNetSpendPaise > trip.budgetPaise : false
  const bucketTotals = calculateTripBucketTotals(transactions, categories)

  return {
    totalNetSpendPaise,
    totalGrossOutflowPaise,
    recoverablePaise,
    repaidPaise,
    pendingPaise,
    days,
    avgPerDayPaise,
    budgetPct,
    isOverBudget,
    bucketTotals,
  }
}

