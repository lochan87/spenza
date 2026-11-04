import type { RecurringItem, Transaction } from '../types/index.ts'
import {
  getNetSpendPaise,
  getRecoverablePaise,
  getRepaidPaise,
  getPendingRecoverablePaise,
  toNonNegativeIntPaise,
} from './splitMath.ts'

/**
 * Calculates the estimated normalized monthly commitment in integer paise across active recurring items.
 *
 * Weekly: Math.round((amountPaise * 52) / 12)
 * Monthly: amountPaise
 * Yearly: Math.round(amountPaise / 12)
 * Paused / inactive items are excluded.
 */
export function calculateNormalizedMonthlyCommitmentPaise(items: RecurringItem[]): number {
  return items
    .filter(i => i.isActive)
    .reduce((sum, item) => {
      const amt = toNonNegativeIntPaise(item.amountPaise)
      switch (item.frequency) {
        case 'weekly':
          return sum + Math.round((amt * 52) / 12)
        case 'monthly':
          return sum + amt
        case 'yearly':
          return sum + Math.round(amt / 12)
        default:
          return sum + amt
      }
    }, 0)
}

/**
 * Calculates net personal spend across recurring transactions (`type === 'recurring'`).
 * Uses `getNetSpendPaise(tx)` so shared recurring bills (e.g. shared streaming subscriptions,
 * shared Wi-Fi, rent, flatmate utilities) isolate only the user's net personal share.
 */
export function calculateRecurringTransactionsNetSpend(transactions: Transaction[]): number {
  return transactions
    .filter(t => t.type === 'recurring')
    .reduce((sum, tx) => sum + getNetSpendPaise(tx), 0)
}

/**
 * Calculates gross outflow (actual money paid from user's account) across recurring transactions.
 * Preserves gross cash outflow for banking reconciliation and payment accounts.
 */
export function calculateRecurringTransactionsGrossOutflow(transactions: Transaction[]): number {
  return transactions
    .filter(t => t.type === 'recurring')
    .reduce((sum, tx) => sum + toNonNegativeIntPaise(tx.amountPaise), 0)
}

/**
 * Calculates recoverable amounts, repaid amounts, and pending dues for recurring transactions.
 */
export function calculateRecurringRecoverablesSummary(transactions: Transaction[]): {
  recoverablePaise: number
  repaidPaise: number
  pendingPaise: number
} {
  const recurringTxns = transactions.filter(t => t.type === 'recurring')
  return {
    recoverablePaise: recurringTxns.reduce((s, t) => s + getRecoverablePaise(t), 0),
    repaidPaise: recurringTxns.reduce((s, t) => s + getRepaidPaise(t), 0),
    pendingPaise: recurringTxns.reduce((s, t) => s + getPendingRecoverablePaise(t), 0),
  }
}
