import type { Transaction } from '../types/index.ts'
import { getNormalizedSplits, getReimbursementStatus } from './splitMath.ts'

export type ExpenseEdit = Partial<Omit<Transaction, 'id' | 'createdAt' | 'updatedAt' | 'isImported' | 'importSource'>>

export class ExpenseEditError extends Error {}

const conflictMessage = 'This expense was changed in another tab or session. Close and reopen it to review the latest values before saving.'
const metadataFields = ['description', 'categoryId', 'date', 'tripId', 'tags', 'notes', 'receiptUrl'] as const
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Repayment amounts/status/timestamps are deliberately excluded: the server's
// current repayment state always wins over the form's snapshot.
function principalState(tx: Transaction) {
  return {
    amountPaise: tx.amountPaise,
    type: tx.type,
    personId: tx.personId ?? null,
    splits: getNormalizedSplits(tx)
      .map(s => ({ personId: s.personId, personName: s.personName, amountPaise: s.amountPaise }))
      .sort((a, b) => a.personId.localeCompare(b.personId)),
  }
}

function validatePrincipals(tx: Transaction) {
  if (!Number.isSafeInteger(tx.amountPaise) || tx.amountPaise <= 0) {
    throw new ExpenseEditError('The expense amount must be a positive whole number of paise.')
  }
  if (tx.recoverablePaise !== undefined && (!Number.isSafeInteger(tx.recoverablePaise) || tx.recoverablePaise < 0 || tx.recoverablePaise > tx.amountPaise)) {
    throw new ExpenseEditError('The recoverable amount must be whole paise within the expense total.')
  }
  if (tx.splits?.length) {
    const ids = new Set<string>()
    let total = 0
    for (const share of tx.splits) {
      const id = share.personId.trim()
      if (!id || ids.has(id) || !Number.isSafeInteger(share.amountPaise) || share.amountPaise <= 0) {
        throw new ExpenseEditError('Check the split participants and their amounts before saving.')
      }
      ids.add(id)
      total += share.amountPaise
    }
    if (!Number.isSafeInteger(total) || total > tx.amountPaise || (tx.recoverablePaise !== undefined && total !== tx.recoverablePaise)) {
      throw new ExpenseEditError('Split amounts must match the recoverable amount and cannot exceed the expense total.')
    }
  }
}

/** Three-way edit merge; call inside a Firestore transaction on every retry. */
export function prepareExpenseEdit(latest: Transaction, original: Transaction, data: ExpenseEdit): ExpenseEdit {
  const proposed = { ...original, ...data }
  validatePrincipals(proposed)
  const patch: ExpenseEdit = {}

  for (const key of metadataFields) {
    if (data[key] === undefined || same(data[key], original[key])) continue
    if (!same(latest[key], original[key]) && !same(latest[key], data[key])) {
      throw new ExpenseEditError(conflictMessage)
    }
    Object.assign(patch, { [key]: data[key] })
  }

  // Payment mode and account are one unit; merging them independently could
  // produce an invalid combination after two tabs edit different fields.
  const payment = (tx: Transaction) => [tx.paymentMode, tx.paymentAccountId]
  if (!same(payment(proposed), payment(original))) {
    if (!same(payment(latest), payment(original)) && !same(payment(latest), payment(proposed))) {
      throw new ExpenseEditError(conflictMessage)
    }
    const requiresAccount = ['UPI', 'Card', 'Bank Transfer'].includes(proposed.paymentMode)
    if (requiresAccount ? !proposed.paymentAccountId?.trim() : proposed.paymentAccountId !== null) {
      throw new ExpenseEditError('Select a valid payment account for this payment mode.')
    }
    patch.paymentMode = proposed.paymentMode
    patch.paymentAccountId = proposed.paymentAccountId
  }

  const wanted = principalState(proposed)
  if (!same(wanted, principalState(original)) && !same(wanted, principalState(latest))) {
    if (!same(principalState(latest), principalState(original))) {
      throw new ExpenseEditError(conflictMessage)
    }
    const currentShares = getNormalizedSplits(latest)
    const desiredShares = getNormalizedSplits(proposed)
    for (const current of currentShares) {
      const desired = desiredShares.find(s => s.personId === current.personId)
      if (current.repaidPaise > 0 && (!desired || desired.amountPaise < current.repaidPaise)) {
        throw new ExpenseEditError(`A repayment has been recorded for ${current.personName}. Their share cannot be removed or reduced below the amount repaid. Close and reopen this expense to review it.`)
      }
    }
    const splits = desiredShares.map(share => {
      const current = currentShares.find(s => s.personId === share.personId)
      const repaidPaise = current?.repaidPaise ?? 0
      return {
        ...share,
        repaidPaise,
        settledAt: repaidPaise === share.amountPaise ? current?.settledAt ?? null : null,
      }
    })
    Object.assign(patch, {
      amountPaise: proposed.amountPaise,
      type: proposed.type,
      personId: proposed.personId ?? null,
      splits,
      recoverablePaise: splits.reduce((sum, s) => sum + s.amountPaise, 0),
      reimbursementStatus: getReimbursementStatus({ ...proposed, splits }),
    })
  }
  return patch
}

export function expenseEditErrorMessage(error: unknown): string {
  if (error instanceof ExpenseEditError) return error.message
  const code = (error as { code?: string } | null)?.code?.replace('firestore/', '')
  if (code === 'unavailable' || code === 'failed-precondition') {
    return 'Could not save this edit. Expense edits require a connection to the server. Check your connection and try again.'
  }
  if (code === 'aborted') return conflictMessage
  return 'Could not save this edit. Your form is still open. Check your connection and permissions, then try again.'
}
