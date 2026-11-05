import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Timestamp } from 'firebase/firestore'
import type { Transaction } from '../../types/index.ts'
import { prepareExpenseEdit, expenseEditErrorMessage, ExpenseEditError } from '../expenseEdit.ts'
import { getNetSpendPaise, getRecoverablePaise, getRepaidPaise, getPendingRecoverablePaise } from '../splitMath.ts'

function expense(): Transaction {
  return {
    id: 'expense', amountPaise: 10000, description: 'Dinner', categoryId: 'food', type: 'everyday',
    date: Timestamp.fromMillis(1000), createdAt: Timestamp.fromMillis(1000), updatedAt: Timestamp.fromMillis(1000),
    paymentMode: 'Cash', paymentAccountId: null, tripId: null, personId: 'friend', tags: [], notes: '', receiptUrl: null,
    recoverablePaise: 5000, reimbursementStatus: 'pending',
    splits: [{ personId: 'friend', personName: 'Friend', amountPaise: 5000, repaidPaise: 0, settledAt: null }],
  }
}

function checkInvariants(tx: Transaction) {
  assert.equal(tx.amountPaise, getNetSpendPaise(tx) + getRecoverablePaise(tx))
  assert.equal(getRecoverablePaise(tx), getRepaidPaise(tx) + getPendingRecoverablePaise(tx))
  for (const s of tx.splits ?? []) {
    assert.ok(Number.isSafeInteger(s.amountPaise) && Number.isSafeInteger(s.repaidPaise))
    assert.ok(s.repaidPaise >= 0 && s.repaidPaise <= s.amountPaise)
  }
}

describe('Expense edits — three-way financial merge', () => {
  it('allows ordinary expense and split edits without concurrent changes', () => {
    const original = expense()
    const patch = prepareExpenseEdit(original, original, {
      description: 'Dinner and dessert', amountPaise: 12000, recoverablePaise: 6000,
      splits: [{ ...original.splits![0], amountPaise: 6000 }],
    })
    assert.equal(patch.description, 'Dinner and dessert')
    assert.equal(patch.splits![0].amountPaise, 6000)
    assert.equal(patch.splits![0].repaidPaise, 0)
    checkInvariants({ ...original, ...patch })
  })

  it('preserves a newer repayment while applying a valid principal change', () => {
    const original = expense()
    const latest = { ...original, splits: [{ ...original.splits![0], repaidPaise: 3000 }], reimbursementStatus: 'partial' as const }
    const patch = prepareExpenseEdit(latest, original, {
      amountPaise: 12000, recoverablePaise: 6000, splits: [{ ...original.splits![0], amountPaise: 6000 }],
    })
    assert.equal(patch.splits![0].repaidPaise, 3000)
    assert.equal(patch.reimbursementStatus, 'partial')
    checkInvariants({ ...latest, ...patch })
    assert.equal(original.splits![0].repaidPaise, 0)
  })

  it('keeps newer repayment totals, status and timestamp on a metadata-only save', () => {
    const original = expense()
    const settledAt = Timestamp.fromMillis(2000)
    const latest = { ...original, reimbursementStatus: 'settled' as const, splits: [{ ...original.splits![0], repaidPaise: 5000, settledAt }] }
    const patch = prepareExpenseEdit(latest, original, { ...original, notes: 'Receipt checked' })
    assert.deepEqual(patch, { notes: 'Receipt checked' })
    const saved = { ...latest, ...patch }
    assert.equal(saved.splits![0].settledAt, settledAt)
    assert.equal(saved.reimbursementStatus, 'settled')
    checkInvariants(saved)
  })

  it('rejects reducing a share below a repayment made after opening the form', () => {
    const original = expense()
    const latest = { ...original, splits: [{ ...original.splits![0], repaidPaise: 4000 }] }
    assert.throws(() => prepareExpenseEdit(latest, original, {
      recoverablePaise: 3000, splits: [{ ...original.splits![0], amountPaise: 3000 }],
    }), /repayment has been recorded/)
  })

  it('rejects removing a repaid person or converting their expense to personal', () => {
    const original = expense()
    const latest = { ...original, splits: [{ ...original.splits![0], repaidPaise: 1 }] }
    assert.throws(() => prepareExpenseEdit(latest, original, { splits: [], recoverablePaise: 0, personId: null }), /repayment has been recorded/)
    assert.throws(() => prepareExpenseEdit(latest, original, {
      personId: 'other', splits: [{ ...original.splits![0], personId: 'other' }],
    }), /repayment has been recorded/)
  })

  it('rejects conflicting principal edits by two tabs', () => {
    const original = expense()
    const firstEdit = { amountPaise: 14000, recoverablePaise: 7000, splits: [{ ...original.splits![0], amountPaise: 7000 }] }
    const latest = { ...original, ...prepareExpenseEdit(original, original, firstEdit) }
    assert.throws(() => prepareExpenseEdit(latest, original, {
      amountPaise: 12000, recoverablePaise: 6000, splits: [{ ...original.splits![0], amountPaise: 6000 }],
    }), /another tab or session/)
    assert.deepEqual(prepareExpenseEdit(latest, original, firstEdit), {})
  })

  it('merges independent two-tab edits without reverting newer financial or metadata fields', () => {
    const original = expense()
    const latest = { ...original, notes: 'Other tab', amountPaise: 12000 }
    const patch = prepareExpenseEdit(latest, original, { ...original, description: 'Updated dinner' })
    assert.deepEqual(patch, { description: 'Updated dinner' })
    assert.throws(() => prepareExpenseEdit(latest, original, { notes: 'Conflicting notes' }), /another tab or session/)
  })

  it('does not create repayment amounts supplied by an edit, including for new participants', () => {
    const original = expense()
    const patch = prepareExpenseEdit(original, original, {
      amountPaise: 20000, recoverablePaise: 10000,
      splits: [
        { ...original.splits![0], repaidPaise: 5000 },
        { personId: 'new', personName: 'New', amountPaise: 5000, repaidPaise: 5000 },
      ],
    })
    assert.deepEqual(patch.splits!.map(s => s.repaidPaise), [0, 0])
    assert.equal(patch.reimbursementStatus, 'pending')
    checkInvariants({ ...original, ...patch })
  })

  it('clears settled status when a fully repaid share legitimately grows', () => {
    const original = expense()
    const latest = { ...original, splits: [{ ...original.splits![0], repaidPaise: 5000, settledAt: Timestamp.fromMillis(2000) }] }
    const patch = prepareExpenseEdit(latest, original, {
      recoverablePaise: 6000, splits: [{ ...original.splits![0], amountPaise: 6000 }],
    })
    assert.equal(patch.splits![0].repaidPaise, 5000)
    assert.equal(patch.splits![0].settledAt, null)
    assert.equal(patch.reimbursementStatus, 'partial')
  })

  it('preserves legacy reimbursable records and protects synthesized settled shares', () => {
    const original = expense()
    delete original.splits
    delete original.recoverablePaise
    original.type = 'reimbursable'
    const latest = { ...original, reimbursementStatus: 'settled' as const }
    assert.deepEqual(prepareExpenseEdit(latest, original, { notes: 'Legacy note' }), { notes: 'Legacy note' })
    assert.throws(() => prepareExpenseEdit(latest, original, { amountPaise: 5000 }), /repayment has been recorded/)
    const patch = prepareExpenseEdit(latest, original, { amountPaise: 12000 })
    assert.equal(patch.splits![0].repaidPaise, 10000)
    assert.equal(patch.reimbursementStatus, 'partial')
    checkInvariants({ ...latest, ...patch })
  })

  it('rejects invalid paise, duplicate participants and overflowing principals rather than clamping', () => {
    const original = expense()
    for (const amountPaise of [1.5, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => prepareExpenseEdit(original, original, { amountPaise }), ExpenseEditError)
    }
    assert.throws(() => prepareExpenseEdit(original, original, { recoverablePaise: 11000 }), ExpenseEditError)
    assert.throws(() => prepareExpenseEdit(original, original, { splits: [original.splits![0], original.splits![0]] }), ExpenseEditError)
    assert.throws(() => prepareExpenseEdit(original, original, { splits: [{ ...original.splits![0], amountPaise: 6000 }] }), ExpenseEditError)
  })

  it('treats payment mode and account as an atomic edit group', () => {
    const original = { ...expense(), paymentMode: 'UPI' as const, paymentAccountId: 'bank' }
    const latest = { ...original, paymentAccountId: 'new-bank' }
    assert.throws(() => prepareExpenseEdit(latest, original, { paymentMode: 'Cash', paymentAccountId: null }), /another tab or session/)
  })

  it('provides explicit connection, conflict and failure messages', () => {
    assert.match(expenseEditErrorMessage({ code: 'unavailable' }), /connection/)
    assert.match(expenseEditErrorMessage({ code: 'firestore/aborted' }), /another tab/)
    assert.match(expenseEditErrorMessage({ code: 'permission-denied' }), /permissions/)
    assert.equal(expenseEditErrorMessage(new ExpenseEditError('Reopen expense')), 'Reopen expense')
  })
})
