import type { Transaction } from '../types/index.ts'

export class ExpenseDeletionError extends Error {
  readonly code = 'expense-deletion-blocked'
}

export const repaymentDeletionMessage = 'This expense cannot be deleted because repayments have been recorded. Partially and fully repaid expenses must be kept to preserve repayment history.'

/** Inspect raw ledger evidence: normalization can clamp malformed historical shares. */
export function assertExpenseCanBeDeleted(tx: Transaction): void {
  if (tx.reimbursementStatus === 'partial' || tx.reimbursementStatus === 'settled') {
    throw new ExpenseDeletionError(repaymentDeletionMessage)
  }
  if (tx.splits == null) return // Legacy records without explicit shares
  const unverifiable = 'This expense cannot be deleted because its repayment history could not be verified.'
  if (!Array.isArray(tx.splits)) throw new ExpenseDeletionError(unverifiable)
  for (const share of tx.splits) {
    if (!share || typeof share !== 'object') throw new ExpenseDeletionError(unverifiable)
    if (share.settledAt != null || (typeof share.repaidPaise === 'number' && share.repaidPaise > 0)) {
      throw new ExpenseDeletionError(repaymentDeletionMessage)
    }
    // Missing repayment fields predate split tracking; malformed values are not proof of zero.
    if (share.repaidPaise !== undefined && share.repaidPaise !== 0) {
      throw new ExpenseDeletionError(unverifiable)
    }
  }
}
