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
  totalBudgetPaise: number
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
  notes: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ─── Recurring ────────────────────────────────────────────────────────────────

export type RecurringFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** Stored in users/{uid}/recurring/{id} */
export interface RecurringItem {
  id: string
  description: string
  amountPaise: number
  categoryId: string
  frequency: RecurringFrequency
  nextDueDate: Timestamp
  paymentMode: PaymentMode
  paymentAccountId: string | null
  isActive: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ─── Person ──────────────────────────────────────────────────────────────────

/** Stored in users/{uid}/people/{id} — for split/reimbursable tracking */
export interface Person {
  id: string
  name: string
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
  createdAt: Timestamp
  updatedAt: Timestamp
}
